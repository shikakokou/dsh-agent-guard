import path from 'node:path'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export const name = 'agent-guard'

export const inject = ['subagents']

export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  scope: z.union(['team', 'all']).default('team').volatile(),
  provider: z.string().default('deepseek-account').volatile(),
  model: z.string().default('deepseek-flash').volatile(),
  reasoningEffort: z.string().default('low').volatile(),
  investigateProvider: z.string().default('deepseek-account').volatile(),
  investigateModel: z.string().default('deepseek-flash').volatile(),
  investigateReasoningEffort: z.string().default('high').volatile(),
  executeProvider: z.string().default('deepseek-account').volatile(),
  executeModel: z.string().default('deepseek-flash').volatile(),
  executeReasoningEffort: z.string().default('low').volatile(),
  // When true, a child keeps the Lead node's provider/model/reasoningEffort (DSH default) instead of the forced trio.
  inheritLeadConfig: z.boolean().default(false).volatile(),
  maxConcurrentChildren: z.number().step(1).min(0).volatile(),
  // Kept so a profile that still stores the old key validates; maxConcurrentChildren wins when both are set.
  maxConcurrentTeammates: z.number().step(1).min(0).volatile(),
  banSleepPolling: z.boolean().default(true).volatile(),
  stepBudget: z.number().step(1).min(0).default(40).volatile(),
  maxFilesPerAgent: z.number().step(1).min(0).default(24).volatile(),
  // Deprecated legacy key
  leadNoWrite: z.boolean().volatile(),
  leadNoExecute: z.boolean().volatile(),
  leadStepBudget: z.number().step(1).min(0).default(24).volatile(),
})

const DEFAULTS = {
  enabled: true,
  scope: 'team',
  provider: 'deepseek-account',
  model: 'deepseek-flash',
  reasoningEffort: 'low',
  investigateProvider: 'deepseek-account',
  investigateModel: 'deepseek-flash',
  investigateReasoningEffort: 'high',
  executeProvider: 'deepseek-account',
  executeModel: 'deepseek-flash',
  executeReasoningEffort: 'low',
  inheritLeadConfig: false,
  maxConcurrentChildren: 4,
  banSleepPolling: true,
  stepBudget: 40,
  maxFilesPerAgent: 24,
  leadNoExecute: true,
  leadStepBudget: 24,
}

const COPY = {
  zh: {
    concurrency: (limit, active) => '并发上限 ' + limit + '：当前已有 ' + active + ' 个 teammate 在运行。等它们结束，或把任务合并给现有 teammate；只读调查再考虑 subagent。',
    sleepPolling: () => '禁止用 Start-Sleep 或 sleep 轮询等待 teammate。teammate 完成时会发消息唤醒你：直接结束本轮，或用 wait_agent 等待；查进度用 list_agents 或 team_task_list。',
    stepBudget: limit => `本轮步数预算已用完（每轮 ${limit} 步，下一轮自动重置）。本轮停止调用工具，直接输出报告：已完成、未完成、剩余项，由上一级决定下一轮怎么继续。`,
    fileBudget: (used, limit) => `本轮已写 ${used} 个不同文件，达到每轮上限 ${limit} 个（下一轮自动重置）。本轮停止写文件，直接输出报告：已完成的改动 + 剩余文件清单，由上一级决定下一轮怎么继续。`,
    leadExecute: (tool, kind) => '你是团队 Lead：不直接执行任务（' + tool + '）。查信息/看代码 → 用 subagent（只读调查）；改代码/写文件 → 用 spawn_teammate 派给 teammate。只有用户消息里明确引用的路径（@、反引号或绝对路径）可以自己 read，验证命令（tsc/build/test/git diff）可以自己跑。'
      + '\n可直接复制的派活模板（照抄填空，一行一个字段）：'
      + (kind === 'modify'
        ? '\nspawn_teammate：goal=<要改什么>；ctx=<文件:行、入口指针、约束>；acceptance=<测试命令与通过条件>；output=<改动文件 + diff --stat>'
        : '\nsubagent：goal=<要查清的问题与结论>；ctx=<文件:行、入口指针、复现命令>；acceptance=<可检查的结论条件>；output=<结论 + 证据路径>'),
    // Injected as one conversation message at the start of every Lead turn (see the turn/start branch in apply).
    leadReminder: () => '你是团队 Lead：本步只派活或复核，不自己执行任务。'
      + '\n禁止 read/grep/glob/write/edit，也不要用 pwsh 读写文件；查信息 → subagent，改代码 → teammate。'
      + '\n本步产出派活消息或复核结论，而不是文件内容。',
    leadScheduling: () => LAW_ZH,
    leadStepBudget: limit => '本轮 Lead 步数预算已用完（每轮 ' + limit + ' 步，下一轮自动重置）。本轮不要再调查或改代码：直接派活（执行→teammate，调查→subagent）、汇总当前状态、结束本轮，等回报或用户指令。',
  },
  en: {
    concurrency: (limit, active) => 'Concurrency limit ' + limit + ': ' + active + ' teammate(s) are already running. Wait for them to finish, or merge this work into an existing teammate; only read-only investigation should consider a subagent.',
    sleepPolling: () => 'Sleep polling for teammates is banned. A finished teammate wakes you with a message: end this turn, or use wait_agent; check progress with list_agents or team_task_list.',
    stepBudget: limit => `This turn's step budget is spent (${limit} steps per turn, resets next turn). Stop calling tools and output a report: done, not done, remaining; the parent decides how to continue next turn.`,
    fileBudget: (used, limit) => `This turn already wrote ${used} distinct files, hitting the per-turn limit of ${limit} (resets next turn). Stop writing files and output a report: completed changes plus the remaining file list; the parent decides how to continue next turn.`,
    leadExecute: (tool, kind) => 'You are the Team Lead: do not execute tasks directly (' + tool + '). To inspect information or read code → use a subagent (read-only investigation); to change code or write files → use spawn_teammate to dispatch to a teammate. Only paths the user explicitly referenced in their message (@, backticks, or absolute paths) may be read by you, and verification commands (tsc/build/test/git diff) may be run by you.'
      + '\nCopy-paste delegation template (fill in the placeholders):'
      + (kind === 'modify'
        ? '\nspawn_teammate: goal=<what to change>; ctx=<file:line, entry points, constraints>; acceptance=<test command and pass condition>; output=<changed files + diff --stat>'
        : '\nsubagent: goal=<question/answer to establish>; ctx=<file:line, entry points, repro command>; acceptance=<checkable conclusion>; output=<conclusion + evidence paths>'),
    leadReminder: () => 'You are the Team Lead: only dispatch work or review results this step.'
      + '\nBanned: read/grep/glob/write/edit and pwsh file I/O; info → subagent, code → teammate.',
    leadScheduling: () => LAW_EN,
    leadStepBudget: limit => `This turn's Lead step budget is spent (${limit} steps per turn, resets next turn). Stop investigating or coding: delegate (execution → teammate, investigation → subagent), summarize the current state, and end this turn to wait for reports or user instructions.`,
  },
}

const LAW_ZH = [
  '## 调度协议（Lead ⇄ teammate / subagent）',
  '先判：一两次命令或 web 查询能做完 → 直接做；否则查信息/只读 → 派 subagent，执行/改代码 → 派 teammate。Lead 不直接执行任务（用户消息里明确引用的路径可读，验证命令可跑）。',
  '',
  '单元字段（缺项不得派）：goal / ctx（文件、入口指针）/ acceptance（可检查条件）/ output（路径+返回）/ deps / owner。',
  '承载：有任务板用 team_task_create（subject=goal，description=ctx+acceptance+output，write_scopes 用相对路径，blocked_by=deps，reassign=owner）；无任务板写进派活消息。',
  '',
  '状态：draft → dispatched → reported → verifying → accepted｜rejected',
  'dispatched 前 Lead 不动该单元；reported 含产物+自检+未决；verifying 只按 acceptance 验；rejected 写未过项，修订重派，最多退 2 次。',
  '',
  '不变式：I1 无 acceptance 不 dispatch；I2 accepted 前不重做；I3 一单元一 owner。',
  '回报：任务 id / owner / 状态。例外：blocked → 补 ctx 重派，或自己接手并说明原因。',
  '分工：subagent 只做只读调查（不写文件、不定稿）；执行与改代码一律派 teammate。',
].join('\n')

const LAW_EN = [
  '## Scheduling protocol (Lead ⇄ teammate / subagent)',
  'Decide first: if one or two commands or a web lookup finish it, do it yourself; otherwise, for information gathering or read-only work → dispatch a subagent, for execution or code changes → dispatch a teammate. The Lead does not execute tasks directly (paths the user explicitly referenced in their message are readable, verification commands may be run).',
  '',
  'Unit (missing any field → do not dispatch): goal / ctx (files, entry pointers) / acceptance (checkable condition) / output (path + what to return) / deps / owner.',
  'Carrier: with a task board use team_task_create (subject=goal, description=ctx+acceptance+output, write_scopes relative paths, blocked_by=deps, reassign=owner); without one, put the same fields in the dispatch message.',
  '',
  'States: draft → dispatched → reported → verifying → accepted｜rejected',
  'Before dispatched the Lead does not touch the unit; reported returns artifact + self-check + open questions; verifying checks only against acceptance; rejected lists failed items, revise and re-dispatch, at most 2 retries.',
  '',
  'Invariants: I1 no acceptance → no dispatch; I2 no redo before accepted; I3 one unit, one owner.',
  'Report: task id / owner / state. Exception: blocked → add ctx and re-dispatch, or take over and say why.',
  'Split: a subagent only does read-only investigation (no file writes, no final artifacts); all execution and code changes go to a teammate.',
].join('\n')

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

const SLEEP_COMMAND = /Start-Sleep\s+-|\bsleep\s+\d/i
const SPAWN_TEAMMATE = 'spawn_teammate'
const CHILD_TOOLS = new Set([SPAWN_TEAMMATE, 'subagent', 'subagent_fork'])
const WRITE_TOOLS = new Set(['write', 'edit', 'str_replace_editor'])
const LEAD_BLOCKED_TOOLS = new Set(['read', 'grep', 'glob', 'write', 'edit', 'str_replace_editor'])
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

export function resolveOptions(config) {
  const legacyConcurrent = readValue(config, 'maxConcurrentTeammates', undefined)
  return {
    enabled: readValue(config, 'enabled', DEFAULTS.enabled) === true,
    scope: readValue(config, 'scope', DEFAULTS.scope) === 'all' ? 'all' : 'team',
    provider: String(readValue(config, 'provider', DEFAULTS.provider)),
    model: String(readValue(config, 'model', DEFAULTS.model)),
    reasoningEffort: String(readValue(config, 'reasoningEffort', DEFAULTS.reasoningEffort)).trim()
      || DEFAULTS.reasoningEffort,
    investigateProvider: String(readValue(config, 'investigateProvider', DEFAULTS.investigateProvider)).trim(),
    investigateModel: String(readValue(config, 'investigateModel', DEFAULTS.investigateModel)).trim(),
    investigateReasoningEffort: String(readValue(config, 'investigateReasoningEffort', DEFAULTS.investigateReasoningEffort)).trim(),
    executeProvider: String(readValue(config, 'executeProvider', DEFAULTS.executeProvider)).trim(),
    executeModel: String(readValue(config, 'executeModel', DEFAULTS.executeModel)).trim(),
    executeReasoningEffort: String(readValue(config, 'executeReasoningEffort', DEFAULTS.executeReasoningEffort)).trim(),
    inheritLeadConfig: readValue(config, 'inheritLeadConfig', DEFAULTS.inheritLeadConfig) === true,
    maxConcurrentChildren: countValue(
      readValue(config, 'maxConcurrentChildren', legacyConcurrent),
      DEFAULTS.maxConcurrentChildren,
    ),
    banSleepPolling: readValue(config, 'banSleepPolling', DEFAULTS.banSleepPolling) === true,
    stepBudget: countValue(readValue(config, 'stepBudget'), DEFAULTS.stepBudget),
    maxFilesPerAgent: countValue(readValue(config, 'maxFilesPerAgent'), DEFAULTS.maxFilesPerAgent),
    leadNoExecute: readValue(
      config,
      'leadNoExecute',
      readValue(config, 'leadNoWrite', DEFAULTS.leadNoExecute),
    ) === true,
    leadStepBudget: countValue(readValue(config, 'leadStepBudget'), DEFAULTS.leadStepBudget),
  }
}

function snapshotOf(options) {
  return Object.freeze({ ...options })
}

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

function forceRequest(request, route) {
  return {
    ...request,
    agentOptions: {
      ...(request.agentOptions ?? {}),
      provider: route.provider,
      model: route.model,
      reasoningEffort: route.reasoningEffort,
    },
  }
}

function childKind(ctx, spec) {
  if (spec?.childId === undefined || spec?.childId === null) return 'investigate'
  const teams = ctx.get('agentTeams', false)
  if (teams === undefined) return 'base'
  try {
    return teams.listMembers(spec?.request?.parent).some(member => member.id === spec.childId)
      ? 'execute'
      : 'base'
  } catch {
    return 'base'
  }
}

function routeFor(options, kind) {
  const base = {
    provider: options.provider,
    model: options.model,
    reasoningEffort: options.reasoningEffort,
  }
  if (kind === 'investigate') {
    return {
      provider: options.investigateProvider || DEFAULTS.investigateProvider,
      model: options.investigateModel || DEFAULTS.investigateModel,
      reasoningEffort: options.investigateReasoningEffort || DEFAULTS.investigateReasoningEffort,
    }
  }
  if (kind === 'execute') {
    return {
      provider: options.executeProvider || DEFAULTS.executeProvider,
      model: options.executeModel || DEFAULTS.executeModel,
      reasoningEffort: options.executeReasoningEffort || DEFAULTS.executeReasoningEffort,
    }
  }
  return base
}

const PATH_MENTION = /@(?:"([^"]+)"|'([^']+)'|([^\s"'`]+))/g
const BACKTICK_SPAN = /`([^`]+)`/g
const WINDOWS_ABSOLUTE_PATH = /[A-Za-z]:[\\/][^\s"'`<>|]+/g
const TRAILING_PATH_PUNCTUATION = /[.,;:!?)\]}，。；：！？）」』】]+$/
const URL_LIKE = /:\/\//
const PATH_LIKE_FILENAME = /^[\w.-]+\.[A-Za-z0-9]{1,10}$/

function textBlocksOf(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
}

export function extractReferencedPaths(text, cwd) {
  if (typeof text !== 'string' || text === '') return []
  const base = typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd()
  const tokens = []
  for (const match of text.matchAll(PATH_MENTION)) {
    const token = match[1] ?? match[2] ?? match[3]
    if (typeof token === 'string') tokens.push(token)
  }
  for (const match of text.matchAll(BACKTICK_SPAN)) {
    const span = match[1]
    if (typeof span === 'string' && (span.includes('/') || span.includes('\\') || PATH_LIKE_FILENAME.test(span))) tokens.push(span)
  }
  for (const match of text.matchAll(WINDOWS_ABSOLUTE_PATH)) {
    tokens.push(match[0])
  }
  const paths = []
  const seen = new Set()
  for (const raw of tokens) {
    const token = raw.trim().replace(TRAILING_PATH_PUNCTUATION, '')
    if (token === '' || URL_LIKE.test(token)) continue
    let resolved
    try {
      resolved = path.normalize(path.resolve(base, token))
    } catch {
      continue
    }
    if (seen.has(resolved)) continue
    seen.add(resolved)
    paths.push(resolved)
  }
  return paths
}

export function isReferencedReadPath(requestedPath, referencedPaths, cwd) {
  if (typeof requestedPath !== 'string' || requestedPath === '') return false
  const list = Array.isArray(referencedPaths) ? referencedPaths : []
  if (list.length === 0) return false
  const base = typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd()
  let requested
  try {
    requested = path.normalize(path.resolve(base, requestedPath))
  } catch {
    return false
  }
  const fold = process.platform === 'win32' ? value => value.toLowerCase() : value => value
  const target = trimTrailingSeparators(fold(requested))
  for (const reference of list) {
    if (typeof reference !== 'string' || reference === '') continue
    let candidate
    try {
      candidate = trimTrailingSeparators(fold(path.normalize(path.resolve(base, reference))))
    } catch {
      continue
    }
    if (target === candidate) return true
    const prefix = candidate.endsWith(path.sep) ? candidate : candidate + path.sep
    if (target.startsWith(prefix)) return true
  }
  return false
}

function trimTrailingSeparators(value) {
  let trimmed = value
  while (trimmed.length > 1) {
    // Keep a drive root such as `D:\` intact instead of reducing it to `D:`.
    if (/^[A-Za-z]:[\\/]$/.test(trimmed)) break
    if (!trimmed.endsWith(path.sep)) break
    trimmed = trimmed.slice(0, -1)
  }
  return trimmed
}

function isUserReferencedRead(exec, agent, referencedPathsBySession) {
  const filePath = filePathOf(exec)
  if (filePath === '') return false
  const session = agent?.session
  const sessionId = session?.id
  if (sessionId === undefined) return false
  const cwd = session.header?.cwd ?? process.cwd()
  let referenced = referencedPathsBySession.get(sessionId)
  if (referenced === undefined) {
    // Backfill from the session history the first time it is checked, so a read
    // that happens before any live user/message event still sees @-mentions.
    referenced = new Set()
    try {
      for (const message of session.deriveMessages()) {
        if (message?.role !== 'user' || message?.source?.kind !== 'user') continue
        const text = textBlocksOf(message.content)
        if (text === '') continue
        for (const referencedPath of extractReferencedPaths(text, cwd)) referenced.add(referencedPath)
      }
    } catch {
    }
    referencedPathsBySession.set(sessionId, referenced)
  }
  return isReferencedReadPath(filePath, [...referenced], cwd)
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

function refusalFor(ctx, exec, options, stepCounts, filesBySession, childrenByParent, referencedPathsBySession, text) {
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

  if (options.maxFilesPerAgent > 0 && delegationDepth(agent) >= 1 && WRITE_TOOLS.has(exec.name)) {
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
  if (leadingTeam && options.leadNoExecute && LEAD_BLOCKED_TOOLS.has(exec.name)) {
    if (exec.name !== 'read' || !isUserReferencedRead(exec, agent, referencedPathsBySession)) {
      ctx.logger.info('[agent-guard] denied %s: team lead must delegate task execution', exec.name)
      return text('leadExecute', exec.name, WRITE_TOOLS.has(exec.name) ? 'modify' : 'inspect')
    }
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
      const kind = childKind(ctx, spec)
      const route = routeFor(options, kind)
      const forced = options.enabled === true
        && options.inheritLeadConfig !== true
        && (options.scope === 'all' || isTeamLead(ctx, spec?.request?.parent))
      if (forced) {
        ctx.logger.info(
          '[agent-guard] overriding subagent start options kind=%s %s/%s effort=%s scope=%s',
          kind, route.provider, route.model, route.reasoningEffort, options.scope,
        )
      }
      const activation = await original.call(
        this,
        forced ? { ...spec, request: forceRequest(spec.request, route) } : spec,
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

  const stepCounts = new Map()
  const filesBySession = new Map()
  const referencedPathsBySession = new Map()
  // Invariant: DSH forces agent.id to be the shared agent/session identity (Agent.id is a
  // SessionId, and AgentRegistry.get documents its argument as "the shared agent/session id"),
  // so agent.id is the primary key here and the session.id from session/event resolves the
  // same entry. The live registry is only needed when agent/created predates this plugin.
  const agentsById = new Map()
  const lastInjectedTurnBySession = new Map()
  const missingAgentWarned = new Set()
  ctx.on('agent/created', ({ agent }) => {
    const agentId = agent?.id
    if (agentId === undefined) return
    agentsById.set(agentId, agent)
  })
  ctx.on('agent/disposed', ({ agent }) => {
    const agentId = agent?.id
    if (agentId === undefined) return
    if (agentsById.get(agentId) === agent) agentsById.delete(agentId)
    lastInjectedTurnBySession.delete(agentId)
    missingAgentWarned.delete(agentId)
  })
  ctx.on('session/event', (session, event) => {
    const id = session?.id
    if (id === undefined) return
    if (event.type === 'turn/start') {
      stepCounts.set(id, 0)
      filesBySession.delete(id)
      injectLeadReminder(id, event.data)
    } else if (event.type === 'step/start') {
      stepCounts.set(id, (stepCounts.get(id) ?? 0) + 1)
    } else if (event.type === 'user/message' && event.data?.source?.kind === 'user') {
      const cwd = session.header?.cwd ?? process.cwd()
      const text = textBlocksOf(event.data.content)
      if (text === '') return
      let referenced = referencedPathsBySession.get(id)
      if (referenced === undefined) {
        referenced = new Set()
        referencedPathsBySession.set(id, referenced)
      }
      for (const referencedPath of extractReferencedPaths(text, cwd)) referenced.add(referencedPath)
    }
  })
  // Hot reload can mount this plugin after an agent was created, in which case agent/created was
  // never observed here: fall back to the live AgentRegistry, which is queried by the same
  // shared agent/session id. A permanent miss is logged once per session instead of every turn.
  function liveAgentFor(sessionId) {
    const known = agentsById.get(sessionId)
    if (known !== undefined) return known
    const registry = ctx.get('agents', false)
    const agent = typeof registry?.get === 'function' ? registry.get(sessionId) : undefined
    if (agent !== undefined) agentsById.set(sessionId, agent)
    return agent
  }
  function injectLeadReminder(sessionId, turnPayload) {
    const agent = liveAgentFor(sessionId)
    if (agent === undefined) {
      if (!missingAgentWarned.has(sessionId)) {
        missingAgentWarned.add(sessionId)
        ctx.logger.warn('[agent-guard] no live agent for session %s; skipping the lead reminder injection', String(sessionId).slice(0, 8))
      }
      return
    }
    const options = resolveOptions(config)
    const leadingTeam = isTeamLead(ctx, agent)
      || (options.scope === 'all' && delegationDepth(agent) === 0)
    if (!(options.enabled && options.leadNoExecute && leadingTeam)) return
    const turn = turnPayload?.turn
    if (typeof turn !== 'number' || turn <= (lastInjectedTurnBySession.get(sessionId) ?? 0)) return
    lastInjectedTurnBySession.set(sessionId, turn)
    try {
      agent.inject(createUserMessage({
        content: [{ type: 'text', text: text('leadReminder') }],
        source: { kind: 'agent-guard' },
      }))
    } catch (error) {
      lastInjectedTurnBySession.delete(sessionId)
      ctx.logger.warn('[agent-guard] could not inject the lead reminder for turn %d: %s', turn, String(error))
    }
  }
  ctx.on('session/disposed', (session) => {
    if (session?.id === undefined) return
    stepCounts.delete(session.id)
    filesBySession.delete(session.id)
    referencedPathsBySession.delete(session.id)
    agentsById.delete(session.id)
    lastInjectedTurnBySession.delete(session.id)
    missingAgentWarned.delete(session.id)
    childrenByParent.delete(session.id)
    forgetChild(childrenByParent, parentOfChild, session.id)
  })

  const language = { value: undefined }
  const text = (key, ...args) => {
    if (language.value === undefined) language.value = readLanguagePreference(ctx) ?? 'zh'
    return COPY[language.value][key](...args)
  }
  ctx.on('settings/document-updated', () => { language.value = undefined })

  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.effect(() => promptCtx.systemPrompt.section({
      name: 'lead-scheduling',
      // 10300 sorts after every first-party section (last named: DEPLOYMENT_PERSONA_SUFFIX = 10200), so this section is appended at the tail of the single system prompt instead of the opening segment.
      order: 10300,
      text: () => text('leadScheduling'),
    }), 'agent-guard.leadScheduling()')
  })

  ctx.on('tools/pre-execute', async (exec, next) => {
    const reason = refusalFor(ctx, exec, resolveOptions(config), stepCounts, filesBySession, childrenByParent, referencedPathsBySession, text)
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
