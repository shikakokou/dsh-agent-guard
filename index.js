import z from '@deepseek-ai/schemastery'

export const name = 'agent-guard'

export const inject = ['subagents']

// Every field is volatile so a settings write reaches the running plugin without a restart.
export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  scope: z.union(['team', 'all']).default('team').volatile(),
  provider: z.string().default('deepseek-account').volatile(),
  model: z.string().default('deepseek-flash').volatile(),
  reasoningEffort: z.string().default('low').volatile(),
  // When true, a child keeps the Lead node's provider/model/reasoningEffort (DSH default) instead of the forced trio.
  inheritLeadConfig: z.boolean().default(false).volatile(),
  maxConcurrentChildren: z.number().step(1).min(0).default(4).volatile(),
  // Kept so a profile that still stores the old key validates; maxConcurrentChildren wins when both are set.
  maxConcurrentTeammates: z.number().step(1).min(0).volatile(),
  banSleepPolling: z.boolean().default(true).volatile(),
  stepBudget: z.number().step(1).min(0).default(25).volatile(),
  maxFilesPerAgent: z.number().step(1).min(0).default(12).volatile(),
  leadNoWrite: z.boolean().default(true).volatile(),
  leadStepBudget: z.number().step(1).min(0).default(24).volatile(),
})

const DEFAULTS = {
  enabled: true,
  scope: 'team',
  provider: 'deepseek-account',
  model: 'deepseek-flash',
  reasoningEffort: 'low',
  inheritLeadConfig: false,
  maxConcurrentChildren: 4,
  banSleepPolling: true,
  stepBudget: 25,
  maxFilesPerAgent: 12,
  leadNoWrite: true,
  leadStepBudget: 24,
}

// Model-facing refusal copy. The Host has no locale service, so the language
// follows the shared settings document's `locale` namespace (namespace `locale`,
// field `preference`) — the same value the Web UI language row persists.
const COPY = {
  zh: {
    concurrency: (limit, active) => `并发上限 ${limit}：当前已有 ${active} 个 teammate 或子 agent 在运行。等它们结束再新建，或把任务合并给现有 agent。`,
    sleepPolling: () => '禁止用 Start-Sleep 或 sleep 轮询等待子 agent。子 agent 完成时会发消息唤醒你：直接结束本轮，或用 wait_agent 等待；查进度用 list_agents 或 team_task_list。',
    stepBudget: limit => `本轮步数预算已用完（每轮 ${limit} 步，下一轮自动重置）。本轮停止调用工具，直接输出报告：已完成、未完成、剩余项，由上一级决定下一轮怎么继续。`,
    fileBudget: (used, limit) => `本轮已写 ${used} 个不同文件，达到每轮上限 ${limit} 个（下一轮自动重置）。本轮停止写文件，直接输出报告：已完成的改动 + 剩余文件清单，由上一级决定下一轮怎么继续。`,
    leadWrite: () => '你是团队 Lead：不要自己改文件。把改动拆成 team_task_create，再用 send_message 把文件清单、验收标准派给 teammate 或 subagent；Lead 只做计划、复核、汇总。确实要自己动手，就先把 Guard 的「Lead 不自己改文件」关掉。',
    leadStepBudget: limit => `本轮 Lead 步数预算已用完（每轮 ${limit} 步，下一轮自动重置）。本轮不要再调查或改代码：直接派活、汇总当前状态、结束本轮，等 teammate 回报或用户指令。`,
  },
  en: {
    concurrency: (limit, active) => `Concurrency limit ${limit}: ${active} teammate/subagent(s) are already running. Wait for them to finish, or merge this work into an existing agent.`,
    sleepPolling: () => 'Sleep polling for subagents is banned. A finished subagent wakes you with a message: end this turn, or use wait_agent; check progress with list_agents or team_task_list.',
    stepBudget: limit => `This turn's step budget is spent (${limit} steps per turn, resets next turn). Stop calling tools and output a report: done, not done, remaining; the parent decides how to continue next turn.`,
    fileBudget: (used, limit) => `This turn already wrote ${used} distinct files, hitting the per-turn limit of ${limit} (resets next turn). Stop writing files and output a report: completed changes plus the remaining file list; the parent decides how to continue next turn.`,
    leadWrite: () => 'You are the Team Lead: do not edit files yourself. Split the change into team_task_create and use send_message to give a teammate or subagent the file list and acceptance criteria; the Lead plans, reviews, and summarizes. If you really must edit yourself, turn off "Lead cannot edit files" in Guard first.',
    leadStepBudget: limit => `This turn's Lead step budget is spent (${limit} steps per turn, resets next turn). Stop investigating or coding: delegate, summarize the current state, and end this turn to wait for teammate reports or user instructions.`,
  },
}

function readLanguagePreference(ctx) {
  try {
    const settings = ctx.get('settings', false)
    const view = settings?.describe?.({ redactSecrets: true })
      ?.namespaces?.find(namespace => namespace.ns === 'locale')
    const preference = view?.value?.preference
    if (typeof preference !== 'string') return undefined
    return preference.toLowerCase().startsWith('en') ? 'en' : 'zh'
  } catch {
    return undefined
  }
}

// Matches PowerShell Start-Sleep and bash sleep with a numeric argument.
const SLEEP_COMMAND = /Start-Sleep\s+-|\bsleep\s+\d/i
const SPAWN_TEAMMATE = 'spawn_teammate'
const CHILD_TOOLS = new Set([SPAWN_TEAMMATE, 'subagent', 'subagent_fork'])
const LEAD_WRITE_TOOLS = new Set(['write', 'edit', 'str_replace_editor'])
const COORDINATION_TOOLS = new Set([
  SPAWN_TEAMMATE, 'subagent', 'subagent_fork', 'send_message', 'interrupt_agent',
  'team_task_create', 'team_task_update', 'team_task_get', 'team_task_list',
  'list_agents', 'wait_agent', 'ask_user_question', 'todo_write', 'present',
])

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
  const legacyConcurrent = readValue(config, 'maxConcurrentTeammates', undefined)
  return {
    enabled: readValue(config, 'enabled', DEFAULTS.enabled) === true,
    scope: readValue(config, 'scope', DEFAULTS.scope) === 'all' ? 'all' : 'team',
    provider: String(readValue(config, 'provider', DEFAULTS.provider)),
    model: String(readValue(config, 'model', DEFAULTS.model)),
    reasoningEffort: String(readValue(config, 'reasoningEffort', DEFAULTS.reasoningEffort)).trim()
      || DEFAULTS.reasoningEffort,
    inheritLeadConfig: readValue(config, 'inheritLeadConfig', DEFAULTS.inheritLeadConfig) === true,
    maxConcurrentChildren: countValue(
      readValue(config, 'maxConcurrentChildren', legacyConcurrent),
      DEFAULTS.maxConcurrentChildren,
    ),
    banSleepPolling: readValue(config, 'banSleepPolling', DEFAULTS.banSleepPolling) === true,
    stepBudget: countValue(readValue(config, 'stepBudget'), DEFAULTS.stepBudget),
    maxFilesPerAgent: countValue(readValue(config, 'maxFilesPerAgent'), DEFAULTS.maxFilesPerAgent),
    leadNoWrite: readValue(config, 'leadNoWrite', DEFAULTS.leadNoWrite) === true,
    leadStepBudget: countValue(readValue(config, 'leadStepBudget'), DEFAULTS.leadStepBudget),
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

function activeConcurrent(ctx, lead, childrenByParent) {
  const teammates = new Set()
  const teams = ctx.get('agentTeams', false)
  if (teams !== undefined) {
    try {
      for (const member of teams.listMembers(lead)) {
        if (member.role === 'teammate' && (member.status === 'running' || member.status === 'provisioning')) {
          teammates.add(member.id)
        }
      }
    } catch {
    }
  }
  const parentId = lead?.session?.id
  const children = parentId === undefined ? undefined : childrenByParent.get(parentId)
  let extra = 0
  if (children !== undefined) {
    for (const id of children) {
      if (!teammates.has(id)) extra += 1
    }
  }
  return teammates.size + extra
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
  for (const [ownerId, children] of childrenByParent) {
    children.delete(childId)
    if (children.size === 0) childrenByParent.delete(ownerId)
  }
}

function activeChildCount(childrenByParent, parentId) {
  const children = parentId === undefined ? undefined : childrenByParent.get(parentId)
  return children === undefined ? 0 : children.size
}

function refusalFor(ctx, exec, options, stepCounts, filesBySession, childrenByParent, text) {
  const agent = exec?.agent
  if (agent === undefined || options.enabled !== true) return undefined

  if (CHILD_TOOLS.has(exec.name) && options.maxConcurrentChildren > 0 && isTeamLead(ctx, agent)) {
    const active = activeConcurrent(ctx, agent, childrenByParent)
    if (active >= options.maxConcurrentChildren) {
      ctx.logger.info('[agent-guard] denied %s: active children %d >= limit %d', exec.name, active, options.maxConcurrentChildren)
      return text('concurrency', options.maxConcurrentChildren, active)
    }
  }

  if (options.banSleepPolling === true && (exec.name === 'pwsh' || exec.name === 'bash')) {
    const command = commandOf(exec)
    if (command !== '' && SLEEP_COMMAND.test(command)) {
      const inScope = options.scope === 'all' || isTeamLead(ctx, agent)
      const busy = options.scope === 'all'
        || activeTeammates(ctx, agent) > 0
        || activeChildCount(childrenByParent, agent.session?.id) > 0
      if (inScope && busy) {
        ctx.logger.info('[agent-guard] denied sleep polling: %s', command.replace(/\s+/g, ' ').slice(0, 80))
        return text('sleepPolling')
      }
    }
  }

  if (options.stepBudget > 0 && delegationDepth(agent) >= 1) {
    const sessionId = agent.session?.id
    const used = sessionId === undefined ? 0 : (stepCounts.get(sessionId) ?? 0)
    // step/start already counted the current step, so N steps are allowed and the (N + 1)-th tool call is refused.
    if (used > options.stepBudget) {
      ctx.logger.info('[agent-guard] child %s reached the step budget %d', String(sessionId).slice(0, 8), options.stepBudget)
      return text('stepBudget', options.stepBudget)
    }
  }

  // Every file-writing tool counts: write, edit, and str_replace_editor (whose `path` argument filePathOf handles).
  if (options.maxFilesPerAgent > 0 && delegationDepth(agent) >= 1 && LEAD_WRITE_TOOLS.has(exec.name)) {
    const sessionId = agent.session?.id
    const path = filePathOf(exec)
    if (sessionId !== undefined && path !== '') {
      const files = filesBySession.get(sessionId) ?? new Set()
      if (!files.has(path)) {
        if (files.size >= options.maxFilesPerAgent) {
          ctx.logger.info('[agent-guard] child %s reached the file budget %d', String(sessionId).slice(0, 8), options.maxFilesPerAgent)
          return text('fileBudget', files.size, options.maxFilesPerAgent)
        }
        files.add(path)
        filesBySession.set(sessionId, files)
      }
    }
  }

  const leadingTeam = isTeamLead(ctx, agent)
    || (options.scope === 'all' && delegationDepth(agent) === 0)
  if (leadingTeam && options.leadNoWrite && LEAD_WRITE_TOOLS.has(exec.name)) {
    ctx.logger.info('[agent-guard] denied %s: team lead must delegate file writes', exec.name)
    return text('leadWrite')
  }

  if (leadingTeam && options.leadStepBudget > 0 && !COORDINATION_TOOLS.has(exec.name)) {
    const sessionId = agent.session?.id
    const used = sessionId === undefined ? 0 : (stepCounts.get(sessionId) ?? 0)
    // Same boundary as stepBudget: N steps may run, the (N + 1)-th non-coordination call is refused.
    if (used > options.leadStepBudget) {
      ctx.logger.info('[agent-guard] team lead %s reached its step budget %d', String(sessionId).slice(0, 8), options.leadStepBudget)
      return text('leadStepBudget', options.leadStepBudget)
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
        && options.inheritLeadConfig !== true
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

  const language = { value: undefined }
  const text = (key, ...args) => {
    if (language.value === undefined) language.value = readLanguagePreference(ctx) ?? 'zh'
    return COPY[language.value][key](...args)
  }
  ctx.on('settings/document-updated', () => { language.value = undefined })

  ctx.on('tools/pre-execute', async (exec, next) => {
    const reason = refusalFor(ctx, exec, resolveOptions(config), stepCounts, filesBySession, childrenByParent, text)
    if (reason !== undefined) return { kind: 'deny', reason }
    return next()
  }, { prepend: true })

  ctx.inject(['sessionProjections'], (projectionCtx) => {
    // The projection runtime only calls schema.parse; the state itself carries no data.
    const passThrough = { parse: value => value }
    let cached = null
    let cachedKey = ''
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
