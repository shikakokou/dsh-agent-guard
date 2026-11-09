import z from '@deepseek-ai/schemastery'

// Host half. Subagent start options are replaced in subagents.startActivation, the
// entry shared by spawn_teammate and the subagent tool. The other guards run in
// tools/pre-execute: team concurrency, sleep polling, per-turn step budget, and a
// per-turn cap on distinct files a subagent may write. Step and file counts come
// from session/event: turn/start resets, step/start increments.

export const name = 'agent-guard'

// Team membership is read through an optional service, so subagents is the only required dependency.
export const inject = ['subagents']

// Every field is volatile so a settings write reaches the running plugin without a restart.
export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  scope: z.union(['team', 'all']).default('team').volatile(),
  provider: z.string().default('deepseek-account').volatile(),
  model: z.string().default('deepseek-flash').volatile(),
  reasoningEffort: z.union(['off', 'low', 'high', 'max']).default('low').volatile(),
  maxConcurrentTeammates: z.number().step(1).min(0).default(4).volatile(),
  banSleepPolling: z.boolean().default(true).volatile(),
  stepBudget: z.number().step(1).min(0).default(25).volatile(),
  maxFilesPerAgent: z.number().step(1).min(0).default(8).volatile(),
})

// Mirrors the Config defaults; used for a field a resolved config does not carry.
const DEFAULTS = {
  enabled: true,
  scope: 'team',
  provider: 'deepseek-account',
  model: 'deepseek-flash',
  reasoningEffort: 'low',
  maxConcurrentTeammates: 4,
  banSleepPolling: true,
  stepBudget: 25,
  maxFilesPerAgent: 8,
}

// Matches PowerShell Start-Sleep and bash sleep with a numeric argument.
const SLEEP_COMMAND = /Start-Sleep\s+-|\bsleep\s+\d/i
const SPAWN_TEAMMATE = 'spawn_teammate'

function readValue(config, key, fallback) {
  const value = config?.[key]
  const resolved = value !== null && typeof value === 'object' && typeof value.get === 'function'
    ? value.get()
    : value
  return resolved === undefined || resolved === null ? fallback : resolved
}

function countValue(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

function resolveOptions(config) {
  return {
    enabled: readValue(config, 'enabled', DEFAULTS.enabled) === true,
    scope: readValue(config, 'scope', DEFAULTS.scope) === 'all' ? 'all' : 'team',
    provider: String(readValue(config, 'provider', DEFAULTS.provider)),
    model: String(readValue(config, 'model', DEFAULTS.model)),
    reasoningEffort: String(readValue(config, 'reasoningEffort', DEFAULTS.reasoningEffort)),
    maxConcurrentTeammates: countValue(readValue(config, 'maxConcurrentTeammates'), DEFAULTS.maxConcurrentTeammates),
    banSleepPolling: readValue(config, 'banSleepPolling', DEFAULTS.banSleepPolling) === true,
    stepBudget: countValue(readValue(config, 'stepBudget'), DEFAULTS.stepBudget),
    maxFilesPerAgent: countValue(readValue(config, 'maxFilesPerAgent'), DEFAULTS.maxFilesPerAgent),
  }
}

function snapshotOf(options) {
  return Object.freeze({ ...options })
}

// Mirrors delegationDepthOf: the session header wins and a runtime subagentDepth may only deepen it.
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

// Counts running and provisioning members; inactive and failed ones do not occupy a slot.
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

function filePathOf(exec) {
  const args = exec?.arguments
  if (args === null || typeof args !== 'object') return ''
  const path = args.file_path ?? args.filePath ?? args.path
  return typeof path === 'string' && path !== '' ? path : ''
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

function rememberChild(childrenByParent, parentOfChild, parent, childId) {
  const parentId = parent?.session?.id
  if (parentId === undefined || childId === undefined) return
  let children = childrenByParent.get(parentId)
  if (children === undefined) {
    children = new Set()
    childrenByParent.set(parentId, children)
  }
  children.add(childId)
  parentOfChild.set(childId, parentId)
}

function forgetChild(childrenByParent, parentOfChild, childId) {
  if (childId === undefined) return
  const parentId = parentOfChild.get(childId)
  parentOfChild.delete(childId)
  if (parentId !== undefined) {
    const children = childrenByParent.get(parentId)
    if (children !== undefined) {
      children.delete(childId)
      if (children.size === 0) childrenByParent.delete(parentId)
    }
    return
  }
  // The end edge can arrive before the start wrapper recorded the child.
  for (const [ownerId, children] of childrenByParent) {
    children.delete(childId)
    if (children.size === 0) childrenByParent.delete(ownerId)
  }
}

function activeChildCount(childrenByParent, parentId) {
  const children = parentId === undefined ? undefined : childrenByParent.get(parentId)
  return children === undefined ? 0 : children.size
}

function refusalFor(ctx, exec, options, stepCounts, filesBySession, childrenByParent) {
  const agent = exec?.agent
  if (agent === undefined || options.enabled !== true) return undefined

  // Only spawn_teammate is capped; the subagent tool keeps its own concurrency.
  if (exec.name === SPAWN_TEAMMATE && options.maxConcurrentTeammates > 0 && isTeamLead(ctx, agent)) {
    const active = activeTeammates(ctx, agent)
    if (active >= options.maxConcurrentTeammates) {
      ctx.logger.info('[agent-guard] denied spawn_teammate: active %d >= limit %d', active, options.maxConcurrentTeammates)
      return `团队并发上限 ${options.maxConcurrentTeammates}：当前已有 ${active} 个 teammate 在运行。等它们结束再新建，或把任务合并给现有 teammate。`
    }
  }

  // An idle team may sleep to wait for an external process; a running teammate or child rejects polling.
  if (options.banSleepPolling === true && (exec.name === 'pwsh' || exec.name === 'bash')) {
    const command = commandOf(exec)
    if (command !== '' && SLEEP_COMMAND.test(command)) {
      const inScope = options.scope === 'all' || isTeamLead(ctx, agent)
      const busy = options.scope === 'all'
        || activeTeammates(ctx, agent) > 0
        || activeChildCount(childrenByParent, agent.session?.id) > 0
      if (inScope && busy) {
        ctx.logger.info('[agent-guard] denied sleep polling: %s', command.replace(/\s+/g, ' ').slice(0, 80))
        return '禁止用 Start-Sleep 或 sleep 轮询等待子 agent。子 agent 完成时会发消息唤醒你：直接结束本轮，或用 wait_agent 等待；查进度用 list_agents 或 team_task_list。'
      }
    }
  }

  if (options.stepBudget > 0 && delegationDepth(agent) >= 1) {
    const sessionId = agent.session?.id
    const used = sessionId === undefined ? 0 : (stepCounts.get(sessionId) ?? 0)
    if (used >= options.stepBudget) {
      ctx.logger.info('[agent-guard] child %s reached the step budget %d', String(sessionId).slice(0, 8), options.stepBudget)
      return `本轮工具预算已用完（${options.stepBudget} 步）。停止调用工具，直接输出报告：已完成、未完成、下一步，由上一级决定是否继续。`
    }
  }

  // Bounds a directory sweep: each subagent turn may write this many distinct files.
  if (options.maxFilesPerAgent > 0 && delegationDepth(agent) >= 1 && (exec.name === 'write' || exec.name === 'edit')) {
    const sessionId = agent.session?.id
    const path = filePathOf(exec)
    if (sessionId !== undefined && path !== '') {
      const files = filesBySession.get(sessionId) ?? new Set()
      if (!files.has(path)) {
        if (files.size >= options.maxFilesPerAgent) {
          ctx.logger.info('[agent-guard] child %s reached the file budget %d', String(sessionId).slice(0, 8), options.maxFilesPerAgent)
          return `本轮已写 ${files.size} 个文件，达到上限 ${options.maxFilesPerAgent} 个。停止继续写文件，直接输出报告：已完成的改动和剩余项。`
        }
        files.add(path)
        filesBySession.set(sessionId, files)
      }
    }
  }

  return undefined
}

export function apply(ctx, config = {}) {
  const childrenByParent = new Map()
  const parentOfChild = new Map()
  const subagents = ctx.subagents
  const original = subagents?.startActivation
  if (typeof original !== 'function') {
    ctx.logger.warn('[agent-guard] subagents.startActivation is missing; start options are not overridden')
  } else {
    const guarded = async function startActivation(spec) {
      const options = resolveOptions(config)
      const forced = options.enabled === true
        && (options.scope === 'all' || isTeamLead(ctx, spec?.request?.parent))
      if (forced) {
        ctx.logger.info(
          '[agent-guard] overriding subagent start options %s/%s effort=%s scope=%s',
          options.provider, options.model, options.reasoningEffort, options.scope,
        )
      }
      const activation = await original.call(
        this,
        forced ? { ...spec, request: forceRequest(spec.request, options) } : spec,
      )
      rememberChild(childrenByParent, parentOfChild, spec?.request?.parent, activation?.childId)
      return activation
    }
    subagents.startActivation = guarded
    if (subagents.startActivation !== guarded) {
      ctx.logger.warn('[agent-guard] subagents.startActivation is not writable; start options are not overridden')
    } else {
      ctx.effect(() => () => {
        if (subagents.startActivation === guarded) subagents.startActivation = original
      }, 'agent-guard.startActivation()')
    }
  }

  ctx.on('subagent/end', (info) => {
    forgetChild(childrenByParent, parentOfChild, info?.id)
  })

  // Step and file budgets reset on turn/start.
  const stepCounts = new Map()
  const filesBySession = new Map()
  ctx.on('session/event', (session, event) => {
    const id = session?.id
    if (id === undefined) return
    if (event.type === 'turn/start') {
      stepCounts.set(id, 0)
      filesBySession.delete(id)
    } else if (event.type === 'step/start') {
      stepCounts.set(id, (stepCounts.get(id) ?? 0) + 1)
    }
  })
  ctx.on('session/disposed', (session) => {
    if (session?.id === undefined) return
    stepCounts.delete(session.id)
    filesBySession.delete(session.id)
    childrenByParent.delete(session.id)
    forgetChild(childrenByParent, parentOfChild, session.id)
  })

  ctx.on('tools/pre-execute', async (exec, next) => {
    const reason = refusalFor(ctx, exec, resolveOptions(config), stepCounts, filesBySession, childrenByParent)
    if (reason !== undefined) return { kind: 'deny', reason }
    return next()
  }, { prepend: true })

  ctx.inject(['sessionProjections'], (projectionCtx) => {
    // The projection runtime only calls schema.parse; the state itself carries no data.
    const passThrough = { parse: value => value }
    let cached = null
    let cachedKey = ''
    // The view reads the live config and reuses one object while the values are unchanged.
    const liveSnapshot = () => {
      const snapshot = snapshotOf(resolveOptions(config))
      const key = JSON.stringify(snapshot)
      if (key !== cachedKey) {
        cached = snapshot
        cachedKey = key
      }
      return cached
    }
    projectionCtx.effect(() => projectionCtx.sessionProjections.register({
      key: 'agentGuard',
      stateVersion: 1,
      stateSchema: passThrough,
      init: () => ({ revision: 0 }),
      apply: state => state,
      wire: { viewSchema: passThrough, view: liveSnapshot },
    }), 'agent-guard.projection()')
  })
}
