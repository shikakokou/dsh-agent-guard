/**
 * Host 半边。启动参数在 `subagents.startActivation` 拦（spawn_teammate 与 subagent 的唯一公共入口），
 * 其余三道在执行前 `tools/pre-execute` 拦；步数从 `session/event` 的 turn/start、step/start 计。
 */

export const name = 'agent-guard'

// 团队身份用软查询，所以只硬依赖 subagents。
export const inject = ['subagents']

// profile 的 agent-guard.config 覆盖这里的默认值。
const DEFAULTS = {
  enabled: true,
  scope: 'team', // team：父 agent 是 Team Lead 时生效；all：所有 agent
  provider: 'deepseek-account',
  model: 'deepseek-flash',
  reasoningEffort: 'low',
  maxConcurrentTeammates: 4, // 0 = 关闭
  banSleepPolling: true,
  stepBudget: 25, // 0 = 关闭
}

// PowerShell 的 Start-Sleep 与 bash 的 sleep 数字都算轮询。
const SLEEP_COMMAND = /Start-Sleep\s+-|\bsleep\s+\d/i
const SPAWN_TEAMMATE = 'spawn_teammate'

// 复刻 delegationDepthOf：会话头权威，运行期 subagentDepth 只能加深。
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

// 只算 running/provisioning；inactive 和 failed 不占名额。
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

function commandOf(exec) {
  const args = exec?.arguments
  if (args === null || typeof args !== 'object') return ''
  const command = args.command ?? args.script
  return typeof command === 'string' ? command : ''
}

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

function refusalFor(ctx, exec, options, stepCounts) {
  const agent = exec?.agent
  if (agent === undefined) return undefined

  // 只拦 spawn_teammate，不动普通 subagent 工具的并发。
  if (exec.name === SPAWN_TEAMMATE && options.maxConcurrentTeammates > 0 && isTeamLead(ctx, agent)) {
    const active = activeTeammates(ctx, agent)
    if (active >= options.maxConcurrentTeammates) {
      ctx.logger.info('[agent-guard] 拒绝 spawn_teammate：活跃 teammate %d ≥ 上限 %d', active, options.maxConcurrentTeammates)
      return `团队并发上限 ${options.maxConcurrentTeammates}：当前已有 ${active} 个 teammate 在跑。等它们结束再开，或把任务合并给现有 teammate。`
    }
  }

  // 团队空闲时 sleep 合法（可能在等外部进程），只拦有活跃 teammate 的轮询。
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

export function apply(ctx, config = {}) {
  const options = { ...DEFAULTS, ...config }
  if (options.enabled !== true) {
    ctx.logger.info('[agent-guard] 已停用')
    return
  }

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

  // 每轮预算在 turn/start 清零。
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

  ctx.on('tools/pre-execute', async (exec, next) => {
    const reason = refusalFor(ctx, exec, options, stepCounts)
    if (reason !== undefined) return { kind: 'deny', reason }
    return next()
  }, { prepend: true })

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
    // 投影运行时只调用 schema.parse(value)，用透传校验器即可，不必引入 schemastery。
    const passThrough = { parse: value => value }
    projectionCtx.effect(() => projectionCtx.sessionProjections.register({
      key: 'agentGuard',
      // 配置一变版本号就变，投影缓存里的旧值随之作废。
      stateVersion: configVersion(snapshot),
      stateSchema: passThrough,
      init: () => snapshot,
      apply: state => state,
      wire: { viewSchema: passThrough, view: state => state },
    }), 'agent-guard.projection()')
  })
}

function configVersion(snapshot) {
  const text = JSON.stringify(snapshot)
  let hash = 5381
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash * 33) ^ text.charCodeAt(index)) >>> 0
  }
  return hash % 2147483647
}
