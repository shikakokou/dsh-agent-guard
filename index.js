import { AsyncLocalStorage } from 'node:async_hooks'
import path from 'node:path'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export const name = 'agent-guard'

export const inject = ['subagents']

export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  scope: z.union(['team', 'all']).default('team').volatile(),
  investigateProvider: z.string().default('deepseek-account').volatile(),
  investigateModel: z.string().default('deepseek-flash').volatile(),
  investigateReasoningEffort: z.string().default('high').volatile(),
  executeProvider: z.string().default('deepseek-account').volatile(),
  executeModel: z.string().default('deepseek-flash').volatile(),
  executeReasoningEffort: z.string().default('low').volatile(),
  inheritLeadConfig: z.boolean().default(false).volatile(),
  maxConcurrentChildren: z.number().step(1).min(0).volatile(),
  banSleepPolling: z.boolean().default(true).volatile(),
  stepBudget: z.number().step(1).min(0).default(40).volatile(),
  maxFilesPerAgent: z.number().step(1).min(0).default(24).volatile(),
  leadNoWrite: z.boolean().volatile(),
  leadNoExecute: z.boolean().volatile(),
  leadStepBudget: z.number().step(1).min(0).default(24).volatile(),
})

const DEFAULTS = {
  enabled: true,
  scope: 'team',
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
    concurrency: (limit, active) => '并发上限 ' + limit + '：当前已有 ' + active + ' 个 subagent 在运行或等待启动。等它们结束，或把任务合并给现有 subagent。',
    delegationName: (tool, name) => '委派名字不合规（' + tool + '）：'
      + (name === '' ? '缺少 name。' : 'name=' + name + ' 不合规。')
      + '规则：以 exec-（执行）或 probe-（只读调查）开头，后面只接小写字母、数字、连字符，总长不超过 32，例如 name=exec-fix-auth、name=probe-locate-handler。',
    sleepPolling: () => '禁止用 Start-Sleep 或 sleep 轮询等待 subagent。subagent 完成时会发消息唤醒你：直接结束本轮，或用 wait_agent 等待；查进度用 list_agents。',
    stepBudget: limit => `本轮步数预算已用完（每轮 ${limit} 步，下一轮自动重置）。本轮停止调用工具，直接输出报告：已完成、未完成、剩余项，由上一级决定下一轮怎么继续。`,
    fileBudget: (used, limit) => `本轮已写 ${used} 个不同文件，达到每轮上限 ${limit} 个（下一轮自动重置）。本轮停止写文件，直接输出报告：已完成的改动 + 剩余文件清单，由上一级决定下一轮怎么继续。`,
    leadExecute: (tool, kind) => '你是 Lead：不直接执行任务（' + tool + '）。查信息/看代码 → 委派给 subagent 做只读调查；改代码/写文件 → 委派给 subagent 做执行任务（要产物与自检）。只有用户消息里明确引用的路径（@、反引号或绝对路径）可以自己 read，验证命令（tsc/build/test/git diff）可以自己跑。'
      + '\n可直接复制的委派模板（照抄填空，一行一个字段）：'
      + (kind === 'modify'
        ? '\nsubagent：name=exec-<做什么>；goal=<要改什么>；ctx=<文件:行、入口指针、约束>；acceptance=<测试命令与通过条件>；output=<改动文件 + diff --stat>'
        : '\nsubagent：name=probe-<查什么>；goal=<要查清的问题与结论>；ctx=<文件:行、入口指针、复现命令>；acceptance=<可检查的结论条件>；output=<结论 + 证据路径>'),
    leadReminder: () => '你是 Lead：本步只委派或复核，不自己执行任务。'
      + '\n禁止 read/grep/glob/write/edit，也不要用 pwsh 读写文件；调查和执行一律委派给 subagent。'
      + '\n本步产出委派消息或复核结论，而不是文件内容。'
      + '\n委派必须带 name=exec-*（执行）或 name=probe-*（只读调查）。',
    leadScheduling: () => LAW_ZH,
    leadStepBudget: limit => '本轮 Lead 步数预算已用完（每轮 ' + limit + ' 步，下一轮自动重置）。本轮不要再调查或改代码：直接委派（一律委派给 subagent）、汇总当前状态、结束本轮，等回报或用户指令。',
  },
  en: {
    concurrency: (limit, active) => 'Concurrency limit ' + limit + ': ' + active + ' subagent(s) are already running or starting. Wait for them to finish, or merge this work into an existing subagent.',
    delegationName: (tool, name) => 'Delegation name is not conforming (' + tool + '): '
      + (name === '' ? 'name is missing. ' : 'name=' + name + ' is not conforming. ')
      + 'Rule: start with exec- (execution) or probe- (read-only investigation), then only lowercase letters, digits and hyphens, at most 32 characters in total, e.g. name=exec-fix-auth or name=probe-locate-handler.',
    sleepPolling: () => 'Sleep polling for subagents is banned. A finished subagent wakes you with a message: end this turn, or use wait_agent; check progress with list_agents.',
    stepBudget: limit => `This turn's step budget is spent (${limit} steps per turn, resets next turn). Stop calling tools and output a report: done, not done, remaining; the parent decides how to continue next turn.`,
    fileBudget: (used, limit) => `This turn already wrote ${used} distinct files, hitting the per-turn limit of ${limit} (resets next turn). Stop writing files and output a report: completed changes plus the remaining file list; the parent decides how to continue next turn.`,
    leadExecute: (tool, kind) => 'You are the Lead: do not execute tasks directly (' + tool + '). To inspect information or read code → dispatch a subagent for read-only investigation; to change code or write files → dispatch a subagent for execution (artifact and self-check required). Only paths the user explicitly referenced in their message (@, backticks, or absolute paths) may be read by you, and verification commands (tsc/build/test/git diff) may be run by you.'
      + '\nCopy-paste delegation template (fill in the placeholders):'
      + (kind === 'modify'
        ? '\nsubagent: name=exec-<what to do>; goal=<what to change>; ctx=<file:line, entry points, constraints>; acceptance=<test command and pass condition>; output=<changed files + diff --stat>'
        : '\nsubagent: name=probe-<what to find>; goal=<question/answer to establish>; ctx=<file:line, entry points, repro command>; acceptance=<checkable conclusion>; output=<conclusion + evidence paths>'),
    leadReminder: () => 'You are the Lead: only dispatch work or review results this step.'
      + '\nBanned: read/grep/glob/write/edit and pwsh file I/O; investigation and execution both go to subagents.'
      + '\nEvery delegation must carry name=exec-* (execution) or name=probe-* (read-only investigation).',
    leadScheduling: () => LAW_EN,
    leadStepBudget: limit => `This turn's Lead step budget is spent (${limit} steps per turn, resets next turn). Stop investigating or coding: delegate (always to subagents), summarize the current state, and end this turn to wait for reports or user instructions.`,
  },
}

const LAW_ZH = [
  '## 调度协议（Lead ⇄ subagent）',
  '先判：一两次命令或 web 查询能做完 → 直接做；否则一律委派给 subagent：查信息/只读 → 只读调查型，执行/改代码 → 执行型（要产物与自检）。Lead 不直接执行任务（用户消息里明确引用的路径可读，验证命令可跑）。',
  '命名：执行任务写 name=exec-<做什么>，只读调查写 name=probe-<查什么>；后面只接小写字母、数字、连字符，总长不超过 32；不符合的委派会被直接拒绝。',
  '',
  '单元字段（缺项不得派）：goal / ctx（文件、入口指针）/ acceptance（可检查条件）/ output（路径+返回）/ deps / owner。',
  '承载：字段写进 subagent 的委派消息；Team 模式开了任务板时，再用 team_task_create 记同一单元（subject=goal，description=ctx+acceptance+output，write_scopes 用相对路径，blocked_by=deps，reassign=owner）。',
  '',
  '状态：draft → dispatched → reported → verifying → accepted｜rejected',
  'dispatched 前 Lead 不动该单元；reported 含产物+自检+未决；verifying 只按 acceptance 验；rejected 写未过项，修订重派，最多退 2 次。',
  '',
  '不变式：I1 无 acceptance 不 dispatch；I2 accepted 前不重做；I3 一单元一 owner。',
  '回报：单元 / owner / 状态。例外：blocked → 补 ctx 重派，或自己接手并说明原因。',
  '分工：只读调查只回结论与证据、不写文件；执行任务交产物、自检并回报未决项。',
].join('\n')

const LAW_EN = [
  '## Scheduling protocol (Lead ⇄ subagent)',
  'Decide first: if one or two commands or a web lookup finish it, do it yourself; otherwise always dispatch a subagent: information gathering or read-only work → the investigation kind, execution or code changes → the execution kind (artifact and self-check required). The Lead does not execute tasks directly (paths the user explicitly referenced in their message are readable, verification commands may be run).',
  'Naming: use name=exec-<what to do> for execution and name=probe-<what to find> for read-only investigation; after the prefix use only lowercase letters, digits and hyphens, at most 32 characters in total; a non-conforming delegation is refused.',
  '',
  'Unit (missing any field → do not dispatch): goal / ctx (files, entry pointers) / acceptance (checkable condition) / output (path + what to return) / deps / owner.',
  'Carrier: the fields go into the subagent dispatch message; when Team mode has a task board, also record the same unit with team_task_create (subject=goal, description=ctx+acceptance+output, write_scopes relative paths, blocked_by=deps, reassign=owner).',
  '',
  'States: draft → dispatched → reported → verifying → accepted｜rejected',
  'Before dispatched the Lead does not touch the unit; reported returns artifact + self-check + open questions; verifying checks only against acceptance; rejected lists failed items, revise and re-dispatch, at most 2 retries.',
  '',
  'Invariants: I1 no acceptance → no dispatch; I2 no redo before accepted; I3 one unit, one owner.',
  'Report: unit / owner / state. Exception: blocked → add ctx and re-dispatch, or take over and say why.',
  'Split: read-only investigation returns conclusions and evidence without writing files; execution delivers the artifact, self-checks, and reports open items.',
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
const DELEGATION_NAME = /^(?=.{1,32}$)(exec|probe)-[a-z0-9-]{1,27}$/
const CHILD_TOOLS = new Set(['subagent', 'subagent_fork'])
const WRITE_TOOLS = new Set(['write', 'edit', 'str_replace_editor'])
const LEAD_BLOCKED_TOOLS = new Set(['read', 'grep', 'glob', 'write', 'edit', 'str_replace_editor'])
const COORDINATION_TOOLS = new Set([
  'subagent', 'subagent_fork', 'send_message', 'interrupt_agent',
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
  return {
    enabled: readValue(config, 'enabled', DEFAULTS.enabled) === true,
    scope: readValue(config, 'scope', DEFAULTS.scope) === 'all' ? 'all' : 'team',
    investigateProvider: String(readValue(config, 'investigateProvider', DEFAULTS.investigateProvider)).trim(),
    investigateModel: String(readValue(config, 'investigateModel', DEFAULTS.investigateModel)).trim(),
    investigateReasoningEffort: String(readValue(config, 'investigateReasoningEffort', DEFAULTS.investigateReasoningEffort)).trim(),
    executeProvider: String(readValue(config, 'executeProvider', DEFAULTS.executeProvider)).trim(),
    executeModel: String(readValue(config, 'executeModel', DEFAULTS.executeModel)).trim(),
    executeReasoningEffort: String(readValue(config, 'executeReasoningEffort', DEFAULTS.executeReasoningEffort)).trim(),
    inheritLeadConfig: readValue(config, 'inheritLeadConfig', DEFAULTS.inheritLeadConfig) === true,
    maxConcurrentChildren: countValue(
      readValue(config, 'maxConcurrentChildren'),
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
  if (teams === undefined || typeof teams.isEnabled !== 'function') return false
  try {
    const subagents = ctx.subagents
    if (typeof subagents?.rootOf === 'function' && subagents.rootOf(agent) !== agent) return false
    return teams.isEnabled(agent) === true
  } catch {
    return false
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

function delegationNameOf(exec) {
  const name = exec?.arguments?.name
  return typeof name === 'string' ? name : ''
}

function forceAgentOptions(agentOptions, route) {
  return {
    ...(agentOptions ?? {}),
    provider: route.provider,
    model: route.model,
    reasoningEffort: route.reasoningEffort,
  }
}

function childKind(spec) {
  const name = typeof spec?.name === 'string' ? spec.name : ''
  if (name.startsWith('exec-')) return 'execute'
  if (name.startsWith('probe-')) return 'investigate'
  return 'base'
}

function routeFor(options, kind) {
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
  return undefined
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

function reservationKey(exec) {
  return exec?.token ?? exec?.signal ?? exec?.callId ?? exec
}

export function createConcurrencyLedger() {
  const activeByParent = new Map()
  const parentOfChild = new Map()
  const pendingByToken = new Map()
  const pendingByParent = new Map()

  function pendingTokens(parentId) {
    let tokens = pendingByParent.get(parentId)
    if (tokens === undefined) {
      tokens = new Set()
      pendingByParent.set(parentId, tokens)
    }
    return tokens
  }

  function activeCount(parentId) {
    const children = parentId === undefined ? undefined : activeByParent.get(parentId)
    return children === undefined ? 0 : children.size
  }

  function pendingCount(parentId) {
    const tokens = parentId === undefined ? undefined : pendingByParent.get(parentId)
    return tokens === undefined ? 0 : tokens.size
  }

  function reserve(token, parentId, signal) {
    if (token === undefined || parentId === undefined) return false
    if (pendingByToken.has(token)) return false
    pendingByToken.set(token, { parentId, signal })
    pendingTokens(parentId).add(token)
    return true
  }

  function release(token) {
    if (token === undefined) return false
    const pending = pendingByToken.get(token)
    if (pending === undefined) return false
    pendingByToken.delete(token)
    const tokens = pendingByParent.get(pending.parentId)
    if (tokens !== undefined) {
      tokens.delete(token)
      if (tokens.size === 0) pendingByParent.delete(pending.parentId)
    }
    return true
  }

  function clearParent(parentId) {
    if (parentId === undefined) return
    activeByParent.delete(parentId)
    const tokens = pendingByParent.get(parentId)
    if (tokens === undefined) return
    for (const token of tokens) pendingByToken.delete(token)
    pendingByParent.delete(parentId)
  }

  return {
    rememberChild(parent, childId) {
      const parentId = parent?.session?.id
      if (parentId === undefined || childId === undefined) return
      let children = activeByParent.get(parentId)
      if (children === undefined) {
        children = new Set()
        activeByParent.set(parentId, children)
      }
      children.add(childId)
      parentOfChild.set(childId, parentId)
    },
    forgetChild(childId) {
      if (childId === undefined) return
      const parentId = parentOfChild.get(childId)
      parentOfChild.delete(childId)
      if (parentId !== undefined) {
        const children = activeByParent.get(parentId)
        if (children !== undefined) {
          children.delete(childId)
          if (children.size === 0) activeByParent.delete(parentId)
        }
        return
      }
      for (const [ownerId, children] of activeByParent) {
        children.delete(childId)
        if (children.size === 0) activeByParent.delete(ownerId)
      }
    },
    activeCount,
    pendingCount,
    inFlightCount(parentId) {
      return activeCount(parentId) + pendingCount(parentId)
    },
    activeTotal() {
      let total = 0
      for (const children of activeByParent.values()) total += children.size
      return total
    },
    pendingTotal() {
      return pendingByToken.size
    },
    pendingParentOf(token) {
      return pendingByToken.get(token)?.parentId
    },
    findBySignal(parentId, signal) {
      if (parentId === undefined || signal === null || typeof signal !== 'object') return undefined
      const tokens = pendingByParent.get(parentId)
      if (tokens === undefined) return undefined
      for (const token of tokens) {
        if (pendingByToken.get(token)?.signal === signal) return token
      }
      return undefined
    },
    reserve,
    release,
    clearParent,
  }
}

function refusalFor(ctx, exec, options, stepCounts, filesBySession, ledger, referencedPathsBySession, text) {
  const agent = exec?.agent
  if (agent === undefined || options.enabled !== true) return undefined

  if (CHILD_TOOLS.has(exec.name)) {
    const name = delegationNameOf(exec)
    if (!DELEGATION_NAME.test(name)) {
      ctx.logger.info(
        '[agent-guard] denied %s: delegation name %s is not exec-/probe-',
        exec.name, name === '' ? '(missing)' : name,
      )
      return text('delegationName', exec.name, name)
    }
  }

  if (options.banSleepPolling === true && (exec.name === 'pwsh' || exec.name === 'bash')) {
    const command = commandOf(exec)
    if (command !== '' && SLEEP_COMMAND.test(command)) {
      const inScope = options.scope === 'all' || isTeamLead(ctx, agent)
      const busy = options.scope === 'all'
        || ledger.activeCount(agent.session?.id) > 0
      if (inScope && busy) {
        ctx.logger.info('[agent-guard] denied sleep polling: %s', command.replace(/\s+/g, ' ').slice(0, 80))
        return text('sleepPolling')
      }
    }
  }

  if (options.stepBudget > 0 && delegationDepth(agent) >= 1) {
    const sessionId = agent.session?.id
    const used = sessionId === undefined ? 0 : (stepCounts.get(sessionId) ?? 0)
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
    if (used > options.leadStepBudget) {
      ctx.logger.info('[agent-guard] team lead %s reached its step budget %d', String(sessionId).slice(0, 8), options.leadStepBudget)
      return text('leadStepBudget', options.leadStepBudget)
    }
  }

  // Reserve last so calls refused above never hold a slot. The reservation is
  // synchronous, so every pre-execute in one assistant step sees the previous
  // reservations before any activation has started.
  if (CHILD_TOOLS.has(exec.name)
    && options.maxConcurrentChildren > 0
    && (options.scope === 'all' || isTeamLead(ctx, agent))) {
    const parentId = agent.session?.id
    const active = ledger.activeCount(parentId)
    const pending = ledger.pendingCount(parentId)
    const inFlight = active + pending
    if (inFlight >= options.maxConcurrentChildren
      || (parentId !== undefined && !ledger.reserve(reservationKey(exec), parentId, exec.signal))) {
      ctx.logger.info(
        '[agent-guard] denied %s: in-flight children %d >= limit %d',
        exec.name, inFlight, options.maxConcurrentChildren,
      )
      return text('concurrency', options.maxConcurrentChildren, inFlight)
    }
  }

  return undefined
}

export function apply(ctx, config = {}) {
  const ledger = createConcurrencyLedger()
  const toolCall = new AsyncLocalStorage()
  const subagents = ctx.subagents
  const original = subagents?.startActivation
  if (typeof original !== 'function') {
    ctx.logger.warn('[agent-guard] subagents.startActivation is missing; start options are not overridden')
  } else {
    const guarded = async function startActivation(spec) {
      const options = resolveOptions(config)
      const name = typeof spec?.name === 'string' ? spec.name : ''
      const callerDelivered = spec?.delivery === 'caller'
      const parentId = spec?.parent?.session?.id
      const call = toolCall.getStore()
      let reservation
      if (call !== undefined && call.parentId === parentId) {
        if (ledger.pendingParentOf(call.token) === parentId) reservation = call.token
      } else if (call === undefined) {
        reservation = ledger.findBySignal(parentId, spec?.signal)
      }
      try {
        if (options.enabled === true && !callerDelivered && !DELEGATION_NAME.test(name)) {
          throw new Error('agent-guard: ' + text('delegationName', 'startActivation', name))
        }
        const kind = childKind(spec)
        const route = routeFor(options, kind)
        const forced = options.enabled === true
          && options.inheritLeadConfig !== true
          && route !== undefined
        if (forced) {
          ctx.logger.info(
            '[agent-guard] overriding subagent start options kind=%s %s/%s effort=%s scope=%s',
            kind, route.provider, route.model, route.reasoningEffort, options.scope,
          )
        }
        const activation = await original.call(
          this,
          forced ? { ...spec, agentOptions: forceAgentOptions(spec?.agentOptions, route) } : spec,
        )
        ledger.rememberChild(spec?.parent, activation?.childId)
        if (reservation !== undefined) ledger.release(reservation)
        return activation
      } catch (error) {
        if (reservation !== undefined) ledger.release(reservation)
        throw error
      }
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

  // Carry the exact tool-call token into the tool body so startActivation can
  // consume the reservation made by this call's pre-execute, not a sibling's.
  ctx.on('tools/execute', (exec, next) => {
    if (!CHILD_TOOLS.has(exec.name)) return next()
    return toolCall.run({ token: reservationKey(exec), parentId: exec.agent?.session?.id }, () => next())
  })

  ctx.on('tools/result', (exec) => {
    if (CHILD_TOOLS.has(exec.name)) ledger.release(reservationKey(exec))
  })

  ctx.on('subagent/end', (info) => {
    ledger.forgetChild(info?.id)
  })

  const stepCounts = new Map()
  const filesBySession = new Map()
  const referencedPathsBySession = new Map()
  const lastInjectedTurnBySession = new Map()
  ctx.on('agent/disposed', ({ agent }) => {
    const agentId = agent?.id
    if (agentId === undefined) return
    lastInjectedTurnBySession.delete(agentId)
  })
  ctx.on('session/event', (session, event) => {
    const id = session?.id
    if (id === undefined) return
    if (event.type === 'turn/start') {
      stepCounts.set(id, 0)
      filesBySession.delete(id)
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
  // agent/pre-step hands back the step's messages and the loop appends them as user/message itself, so the reminder enters here (the turn number keeps it to a turn's first step).
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision?.kind !== 'enter') return decision
    const agent = payload?.agent
    const sessionId = agent?.session?.id ?? agent?.id
    if (sessionId === undefined) return decision
    const options = resolveOptions(config)
    const leadingTeam = isTeamLead(ctx, agent)
      || (options.scope === 'all' && delegationDepth(agent) === 0)
    if (!(options.enabled && options.leadNoExecute && leadingTeam)) return decision
    const turn = payload.turn
    if (typeof turn !== 'number' || turn <= (lastInjectedTurnBySession.get(sessionId) ?? 0)) return decision
    lastInjectedTurnBySession.set(sessionId, turn)
    return {
      ...decision,
      messages: [
        ...decision.messages,
        createUserMessage({
          content: [{ type: 'text', text: text('leadReminder') }],
          source: { kind: 'agent-guard' },
        }),
      ],
    }
  })
  ctx.on('session/disposed', (session) => {
    if (session?.id === undefined) return
    stepCounts.delete(session.id)
    filesBySession.delete(session.id)
    referencedPathsBySession.delete(session.id)
    lastInjectedTurnBySession.delete(session.id)
    ledger.clearParent(session.id)
    ledger.forgetChild(session.id)
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
      order: 10300,
      text: () => text('leadScheduling'),
    }), 'agent-guard.leadScheduling()')
  })

  ctx.on('tools/pre-execute', async (exec, next) => {
    const reason = refusalFor(ctx, exec, resolveOptions(config), stepCounts, filesBySession, ledger, referencedPathsBySession, text)
    if (reason !== undefined) return { kind: 'deny', reason }
    return next()
  }, { prepend: true })

  ctx.inject(['sessionProjections'], (projectionCtx) => {
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
    projectionCtx.effect(() => {
      let handle
      let disposed = false
      const registration = Promise.resolve(projectionCtx.sessionProjections.register({
        key: 'agentGuard',
        stateVersion: 1,
        stateSchema: passThrough,
        init: () => ({ revision: 0 }),
        apply: state => state,
        wire: { viewSchema: passThrough, view: liveSnapshot },
      }))
      registration.then((registered) => {
        if (typeof registered?.dispose !== 'function') return undefined
        if (disposed) return registered.dispose()
        handle = registered
        return undefined
      }, (error) => {
        projectionCtx.logger?.warn?.('[agent-guard] could not register the agentGuard projection: %s', String(error))
      })
      return () => {
        disposed = true
        if (handle !== undefined) return handle.dispose()
        return registration.then(() => undefined, () => undefined)
      }
    }, 'agent-guard.projection()')
  })
}
