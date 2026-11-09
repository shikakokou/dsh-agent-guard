/**
 * dsh-agent-guard · Host 半边
 *
 * 四道硬约束（全部在 Host 执行，模型想绕也绕不过）：
 * 1. 子智能体启动参数：覆盖 `subagents.startActivation` 的 agentOptions（provider/model/reasoningEffort）；
 * 2. 团队并发上限：活跃 teammate 达到上限时拒绝新的 `spawn_teammate`；
 * 3. 禁 sleep 轮询：团队有活跃成员时，拒绝 Lead 的 `Start-Sleep` / `sleep` 命令；
 * 4. 步数预算：子 agent 每轮 step 数超过预算后，拒绝它继续调用工具，逼它先报告。
 *
 * 拦截点：
 * - 启动参数 → `ctx.subagents.startActivation`（spawn_teammate / subagent 两条路径的唯一入口）；
 * - 并发、sleep、预算 → `tools/pre-execute` 瀑布（返回 `{kind:'deny'}` 即执行前拒绝）；
 * - 步数统计 → `session/event` 的 `turn/start`（清零）与 `step/start`（累加）。
 */

/** Cordis plugin name。 */
export const name = 'agent-guard'

/** 本插件只依赖子智能体运行时；团队身份检测在用到时软查询。 */
export const inject = ['subagents']

/** 默认强制值；profile 里给 `agent-guard` 条目写 config 可覆盖。 */
const DEFAULTS = {
  enabled: true,
  /** `team` = 只作用于团队模式（父 agent 是 Team Lead）；`all` = 所有 agent。 */
  scope: 'team',
  provider: 'deepseek-account',
  model: 'deepseek-flash',
  reasoningEffort: 'low',
  /** 同时运行的 teammate 上限；0 = 关闭。 */
  maxConcurrentTeammates: 4,
  /** 团队有活跃成员时，拒绝 Lead 的 Start-Sleep / sleep 轮询。 */
  banSleepPolling: true,
  /** 子 agent 每轮最多 step 数，超过后拒绝工具调用；0 = 关闭。 */
  stepBudget: 25,
}

/** 睡眠命令：PowerShell 的 Start-Sleep，或 bash 的 `sleep 数字`。 */
const SLEEP_COMMAND = /Start-Sleep\s+-|\bsleep\s+\d/i
/** spawn_teammate 的 tool 名。 */
const SPAWN_TEAMMATE = 'spawn_teammate'

/**
 * agent 的委派深度，复刻 `delegationDepthOf`：取运行期 subagentDepth 与会话头 delegationDepth 的较大值。
 * @param agent - 待判定的 agent。
 * @returns 深度；读不到按 0（顶层）处理。
 */
function delegationDepth(agent) {
  try {
    const runtime = agent?.options?.subagentDepth
    const header = agent?.session?.header?.delegationDepth
    const depth = Math.max(typeof header === 'number' ? header : 0, typeof runtime === 'number' ? runtime : 0)
    return Number.isFinite(depth) ? depth : 0
  } catch {
    return 0
  }
}

/**
 * 父 agent 是否是 Team Lead。非团队会话里 `agentTeams` 不存在，返回 false。
 * @param ctx - 插件上下文。
 * @param agent - 待判定的 agent。
 * @returns 是否以 Team Lead 身份在团队里。
 */
function isTeamLead(ctx, agent) {
  if (agent === undefined || agent === null) return false
  const teams = ctx.get('agentTeams', false)
  if (teams === undefined) return false
  try {
    return teams.tryMembership(agent)?.role === 'lead'
  } catch {
    return false
  }
}

/**
 * 团队里正在运行或正在创建的 teammate 数量（不含 Lead、不含已 inactive/failed 的）。
 * @param ctx - 插件上下文。
 * @param lead - 团队 Lead。
 * @returns 活跃 teammate 数；拿不到团队服务时 0。
 */
function activeTeammates(ctx, lead) {
  const teams = ctx.get('agentTeams', false)
  if (teams === undefined) return 0
  try {
    return teams.listMembers(lead)
      .filter(member => member.role === 'teammate')
      .filter(member => member.status === 'running' || member.status === 'provisioning')
      .length
  } catch {
    return 0
  }
}

/**
 * 从工具调用参数里取要执行的命令文本（pwsh / bash 的参数名是 command）。
 * @param exec - tools/pre-execute 的调用对象。
 * @returns 命令文本；取不到返回空串。
 */
function commandOf(exec) {
  const args = exec?.arguments
  if (args === null || typeof args !== 'object') return ''
  const command = args.command ?? args.script
  return typeof command === 'string' ? command : ''
}

/**
 * 用强制参数覆盖一次启动请求，不改调用方传进来的对象。
 * @param request - 原始 `spec.request`。
 * @param options - 归一化后的强制参数。
 * @returns 覆盖了 agentOptions 的新请求。
 */
function forceRequest(request, options) {
  return {
    ...request,
    agentOptions: {
      ...(request.agentOptions ?? {}),
      provider: options.provider,
      model: options.model,
      reasoningEffort: options.reasoningEffort,
    },
  }
}

/**
 * 判定一次工具调用是否要被拒绝。
 * @param ctx - 插件上下文。
 * @param exec - tools/pre-execute 的调用对象。
 * @param options - 归一化配置。
 * @param stepCounts - sessionId → 本轮已开始的 step 数。
 * @returns 拒绝原因；`undefined` 表示放行。
 */
function refusalFor(ctx, exec, options, stepCounts) {
  const agent = exec?.agent
  if (agent === undefined) return undefined

  // 1. 团队并发上限：只拦新建 teammate。
  if (exec.name === SPAWN_TEAMMATE && options.maxConcurrentTeammates > 0 && isTeamLead(ctx, agent)) {
    const active = activeTeammates(ctx, agent)
    if (active >= options.maxConcurrentTeammates) {
      ctx.logger.info('[agent-guard] 拒绝 spawn_teammate：活跃 teammate %d ≥ 上限 %d', active, options.maxConcurrentTeammates)
      return `团队并发上限 ${options.maxConcurrentTeammates}：当前已有 ${active} 个 teammate 在跑。等它们结束再开，或把任务合并给现有 teammate。`
    }
  }

  // 2. 禁 sleep 轮询：团队有活跃成员时，Lead 不许用 sleep 等子 agent。
  if (options.banSleepPolling === true && (exec.name === 'pwsh' || exec.name === 'bash')) {
    const command = commandOf(exec)
    if (command !== '' && SLEEP_COMMAND.test(command)) {
      const inScope = options.scope === 'all' || isTeamLead(ctx, agent)
      const teamBusy = options.scope === 'all' || activeTeammates(ctx, agent) > 0
      if (inScope && teamBusy) {
        ctx.logger.info('[agent-guard] 拒绝 sleep 轮询：%s', command.replace(/\s+/g, ' ').slice(0, 80))
        return '禁止用 Start-Sleep / sleep 轮询等待子 agent。它们完成会以消息唤醒你：直接结束本轮，或用 wait_agent 等待；要查进度用 list_agents / team_task_list。'
      }
    }
  }

  // 3. 步数预算：子 agent 本轮 step 数到顶后拒绝继续调用工具，逼它先报告。
  if (options.stepBudget > 0 && delegationDepth(agent) >= 1) {
    const sessionId = agent.session?.id
    const used = sessionId === undefined ? 0 : (stepCounts.get(sessionId) ?? 0)
    if (used >= options.stepBudget) {
      ctx.logger.info('[agent-guard] 子 agent %s 达到步数预算 %d', String(sessionId).slice(0, 8), options.stepBudget)
      return `本轮工具预算已用完（${options.stepBudget} 步）。不要再调用工具：直接输出报告——已完成 / 未完成 / 下一步，由上一级决定是否继续。`
    }
  }

  return undefined
}

/**
 * 安装四道约束。
 * @param ctx - 插件上下文。
 * @param config - 可选，覆盖 {@link DEFAULTS}。
 */
export function apply(ctx, config = {}) {
  const options = { ...DEFAULTS, ...config }
  if (options.enabled !== true) {
    ctx.logger.info('[agent-guard] 已停用')
    return
  }

  // 一、子智能体启动参数。
  const subagents = ctx.subagents
  const original = subagents?.startActivation
  if (typeof original !== 'function') {
    ctx.logger.warn('[agent-guard] subagents.startActivation 不存在，启动参数护栏未生效')
  } else {
    const guarded = async function startActivation(spec) {
      const forced = options.scope === 'all' || isTeamLead(ctx, spec?.request?.parent)
      if (!forced) return original.call(this, spec)
      ctx.logger.info(
        '[agent-guard] 强制子智能体启动参数 %s/%s effort=%s（scope=%s）',
        options.provider, options.model, options.reasoningEffort, options.scope,
      )
      return original.call(this, { ...spec, request: forceRequest(spec.request, options) })
    }
    subagents.startActivation = guarded
    if (subagents.startActivation !== guarded) {
      ctx.logger.warn('[agent-guard] 无法覆盖 subagents.startActivation（服务实例只读），启动参数护栏未生效')
    } else {
      ctx.effect(() => () => {
        if (subagents.startActivation === guarded) subagents.startActivation = original
      }, 'agent-guard.startActivation()')
    }
  }

  // 二、步数账本：每个会话在本轮已走到第几个 step。
  const stepCounts = new Map()
  ctx.on('session/event', (session, event) => {
    const id = session?.id
    if (id === undefined) return
    if (event.type === 'turn/start') stepCounts.set(id, 0)
    else if (event.type === 'step/start') stepCounts.set(id, (stepCounts.get(id) ?? 0) + 1)
  })
  ctx.on('session/disposed', (session) => {
    if (session?.id !== undefined) stepCounts.delete(session.id)
  })

  // 三、执行前护栏：并发上限、sleep 轮询、步数预算。
  ctx.on('tools/pre-execute', async (exec, next) => {
    const reason = refusalFor(ctx, exec, options, stepCounts)
    if (reason !== undefined) return { kind: 'deny', reason }
    return next()
  }, { prepend: true })

  // 四、把生效配置投影给浏览器半边：浮窗直接读这份值，配置只改一处。
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    const snapshot = Object.freeze({
      enabled: options.enabled === true,
      scope: options.scope === 'all' ? 'all' : 'team',
      provider: String(options.provider),
      model: String(options.model),
      reasoningEffort: String(options.reasoningEffort),
      maxConcurrentTeammates: Number.isFinite(options.maxConcurrentTeammates)
        ? options.maxConcurrentTeammates
        : DEFAULTS.maxConcurrentTeammates,
      banSleepPolling: options.banSleepPolling === true,
      stepBudget: Number.isFinite(options.stepBudget) ? options.stepBudget : DEFAULTS.stepBudget,
    })
    // 投影运行时只调用 schema.parse(value)；这里只需要一个透传校验器，不必引入 schemastery。
    const passThrough = { parse: value => value }
    projectionCtx.effect(() => projectionCtx.sessionProjections.register({
      key: 'agentGuard',
      // 配置一变就换版本，投影缓存里的旧值随之作废。
      stateVersion: configVersion(snapshot),
      stateSchema: passThrough,
      init: () => snapshot,
      apply: state => state,
      wire: { viewSchema: passThrough, view: state => state },
    }), 'agent-guard.projection()')
  })
}

/**
 * 由配置快照算一个稳定的非负整数版本号，用于投影缓存失效。
 * @param snapshot - 公开配置快照。
 * @returns 0 – 2147483646 之间的整数。
 */
function configVersion(snapshot) {
  const text = JSON.stringify(snapshot)
  let hash = 5381
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash * 33) ^ text.charCodeAt(index)) >>> 0
  }
  return hash % 2147483647
}
