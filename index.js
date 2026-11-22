import { AsyncLocalStorage } from 'node:async_hooks'
import path from 'node:path'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as prompts from './src/prompts.js'

export const name = 'agent-guard'

export const inject = ['subagents']

// Per-agent-prefix budgets. The table is used only while the `budgets` key is
// absent; once present, every field is read literally (0 means no limit).
const DEFAULT_BUDGETS = {
  'probe-': { stepBudget: 20, readCalls: 10, readFiles: 5, writeFiles: 0, reminders: [10] },
  'exec-': { stepBudget: 40, readCalls: 30, readFiles: 20, writeFiles: 0, reminders: [12, 28] },
}

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
  budgets: z.dict(z.object({
    stepBudget: z.number().step(1).min(0).default(0),
    readCalls: z.number().step(1).min(0).default(0),
    readFiles: z.number().step(1).min(0).default(0),
    writeFiles: z.number().step(1).min(0).default(0),
    reminders: z.array(z.number().step(1).min(0)).default([]),
  })).default(DEFAULT_BUDGETS).volatile(),
  leadNoWrite: z.boolean().volatile(),
  leadNoExecute: z.boolean().volatile(),
  leadStepBudget: z.number().step(1).min(0).default(24).volatile(),
  leadSchedulingText: z.string().default(prompts.LEAD_SCHEDULING).volatile(),
  contractText: z.string().default(prompts.CONTRACT).volatile(),
  leadReminderText: z.string().default(prompts.LEAD_REMINDER).volatile(),
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
  leadNoExecute: true,
  leadStepBudget: 24,
  leadSchedulingText: prompts.LEAD_SCHEDULING,
  contractText: prompts.CONTRACT,
  leadReminderText: prompts.LEAD_REMINDER,
}

const COPY = {
  zh: {
    concurrency: (limit, active) => '并发上限 ' + limit + '：当前已有 ' + active + ' 个 subagent 在运行或等待启动。等它们结束，或把任务合并给现有 subagent。',
    delegationName: (tool, name) => '委派名字不合规（' + tool + '）：'
      + (name === '' ? '缺少 name。' : 'name=' + name + ' 不合规。')
      + '规则：以 exec-（执行）或 probe-（只读调查）开头，后面只接小写字母、数字、连字符，总长不超过 32，例如 name=exec-fix-auth、name=probe-locate-handler。',
    sleepPolling: () => '禁止用 Start-Sleep 或 sleep 轮询等待 subagent。subagent 完成时会发消息唤醒你：直接结束本轮，或用 wait_agent 等待；查进度用 list_agents。',
    stepBudget: limit => `本轮步数预算已用完（该前缀每轮 ${limit} 步，下一轮自动重置）。本轮停止调用工具，直接输出报告：已完成、未完成、剩余项，由上一级决定下一轮怎么继续。`,
    writeBudget: (used, limit) => `本轮已写 ${used} 个不同文件，达到该前缀每轮写入上限 ${limit} 个（下一轮自动重置）。本轮停止写文件，直接输出报告：已完成的改动 + 剩余文件清单，由上一级决定下一轮怎么继续。`,
    readBudget: (calls, files, callLimit, fileLimit) => `本轮只读预算：read/grep/glob 已用 ${calls} 次调用、read 已读 ${files} 个不同文件（上限 ${callLimit} 次 / ${fileLimit} 个文件，下一轮自动重置），本次调用将超过上限。本轮立即输出结论或报告阻塞，不要继续探索。`,
    readReminder: (step, calls, files, remaining) => `只读预算提醒（第 ${step} 步，已读 ${files} 个不同文件、调用 ${calls} 次，剩余 ${remaining} 步）：若仍在探索，停止并报告结论/证据/未决/阻塞点；若已在收尾，继续做到完成。`,
    leadExecute: (tool, kind) => '你是 Lead：不直接执行任务（' + tool + '）。查信息/看代码 → 委派给 subagent 做只读调查；改代码/写文件 → 委派给 subagent 做执行任务（要产物与自检）。只有用户消息里明确引用的路径（@、反引号或绝对路径）可以自己 read，验证命令（tsc/build/test/git diff）可以自己跑。'
      + '\n可直接复制的委派模板（照抄填空，一行一个字段）：'
      + (kind === 'modify'
        ? '\nsubagent：name=exec-<做什么>；goal=<要改什么>；ctx=<文件:行、入口指针、约束>；acceptance=<测试命令与通过条件>；output=<改动文件 + diff --stat>'
        : '\nsubagent：name=probe-<查什么>；goal=<要查清的问题与结论>；ctx=<文件:行、入口指针、复现命令>；acceptance=<可检查的结论条件>；output=<结论 + 证据路径>'),
    leadStepBudget: limit => '本轮 Lead 步数预算已用完（每轮 ' + limit + ' 步，下一轮自动重置）。本轮不要再调查或改代码：直接委派（一律委派给 subagent）、汇总当前状态、结束本轮，等回报或用户指令。',
  },
  en: {
    concurrency: (limit, active) => 'Concurrency limit ' + limit + ': ' + active + ' subagent(s) are already running or starting. Wait for them to finish, or merge this work into an existing subagent.',
    delegationName: (tool, name) => 'Delegation name is not conforming (' + tool + '): '
      + (name === '' ? 'name is missing. ' : 'name=' + name + ' is not conforming. ')
      + 'Rule: start with exec- (execution) or probe- (read-only investigation), then only lowercase letters, digits and hyphens, at most 32 characters in total, e.g. name=exec-fix-auth or name=probe-locate-handler.',
    sleepPolling: () => 'Sleep polling for subagents is banned. A finished subagent wakes you with a message: end this turn, or use wait_agent; check progress with list_agents.',
    stepBudget: limit => `This turn's step budget is spent (${limit} steps per turn for this prefix, resets next turn). Stop calling tools and output a report: done, not done, remaining; the parent decides how to continue next turn.`,
    writeBudget: (used, limit) => `This turn already wrote ${used} distinct files, hitting the per-prefix write limit of ${limit} per turn (resets next turn). Stop writing files and output a report: completed changes plus the remaining file list; the parent decides how to continue next turn.`,
    readBudget: (calls, files, callLimit, fileLimit) => `This turn's read budget: read/grep/glob have used ${calls} calls and read has covered ${files} distinct files (limit ${callLimit} calls / ${fileLimit} files, resets next turn); this call would exceed the limit. Output the conclusion or report the blocker now; do not keep exploring.`,
    readReminder: (step, calls, files, remaining) => `Read-budget reminder (step ${step}: ${files} distinct files read, ${calls} calls, ${remaining} steps left): if you are still exploring, stop and report conclusion / evidence / open items / blockers; if you are finishing, continue to completion.`,
    leadExecute: (tool, kind) => 'You are the Lead: do not execute tasks directly (' + tool + '). To inspect information or read code → dispatch a subagent for read-only investigation; to change code or write files → dispatch a subagent for execution (artifact and self-check required). Only paths the user explicitly referenced in their message (@, backticks, or absolute paths) may be read by you, and verification commands (tsc/build/test/git diff) may be run by you.'
      + '\nCopy-paste delegation template (fill in the placeholders):'
      + (kind === 'modify'
        ? '\nsubagent: name=exec-<what to do>; goal=<what to change>; ctx=<file:line, entry points, constraints>; acceptance=<test command and pass condition>; output=<changed files + diff --stat>'
        : '\nsubagent: name=probe-<what to find>; goal=<question/answer to establish>; ctx=<file:line, entry points, repro command>; acceptance=<checkable conclusion>; output=<conclusion + evidence paths>'),
    leadStepBudget: limit => `This turn's Lead step budget is spent (${limit} steps per turn, resets next turn). Stop investigating or coding: delegate (always to subagents), summarize the current state, and end this turn to wait for reports or user instructions.`,
  },
}

// Runtime-context name and placement for the contract. DSH exposes no exported
// constant for context orders, only `getContextOrder(name)`; the centrally
// allocated SUBAGENT_DELEGATION slot is 120 in DSH 0.2.2-rc.5. The fallback is
// used only when a foreign/older systemPrompt lacks getContextOrder, and keeps
// the contract after the delegation contexts.
const CONTRACT_CONTEXT_NAME = 'agent-guard:contract'
const CONTRACT_CONTEXT_ORDER_FALLBACK = 121
const BUDGET_CONTEXT_NAME = 'agent-guard:read-budget'
const BUDGET_CONTEXT_ORDER_FALLBACK = 122

function contractContextOrder(systemPrompt) {
  try {
    const base = typeof systemPrompt?.getContextOrder === 'function'
      ? systemPrompt.getContextOrder('SUBAGENT_DELEGATION')
      : undefined
    return typeof base === 'number' && Number.isFinite(base)
      ? base + 1
      : CONTRACT_CONTEXT_ORDER_FALLBACK
  } catch {
    return CONTRACT_CONTEXT_ORDER_FALLBACK
  }
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

const SLEEP_COMMAND = /Start-Sleep\s+-|\bsleep\s+\d/i
const DELEGATION_NAME = /^(?=.{1,32}$)(exec|probe)-[a-z0-9-]{1,27}$/
const CHILD_TOOLS = new Set(['subagent', 'subagent_fork'])
const WRITE_TOOLS = new Set(['write', 'edit', 'str_replace_editor'])
const READ_TOOLS = new Set(['read', 'grep', 'glob'])
const READ_PATH_PLACEHOLDER = '<cwd>'
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

// A missing or invalid budget field is 0, which means no limit. This is
// deliberately not merged with any default: only the whole `budgets` table
// being absent selects DEFAULT_BUDGETS.
function budgetCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function unwrapConfigValue(value) {
  return value !== null && typeof value === 'object' && typeof value.get === 'function'
    ? value.get()
    : value
}

function reminderList(value) {
  if (!Array.isArray(value)) return []
  const reminders = []
  for (const item of value) {
    if (typeof item === 'number' && Number.isFinite(item) && item > 0 && !reminders.includes(item)) {
      reminders.push(item)
    }
  }
  reminders.sort((left, right) => left - right)
  return reminders
}

function normalizeBudget(value) {
  const source = unwrapConfigValue(value)
  const entry = source !== null && typeof source === 'object' && !Array.isArray(source) ? source : {}
  return {
    stepBudget: budgetCount(entry.stepBudget),
    readCalls: budgetCount(entry.readCalls),
    readFiles: budgetCount(entry.readFiles),
    writeFiles: budgetCount(entry.writeFiles),
    reminders: reminderList(entry.reminders),
  }
}

export function normalizeBudgets(raw) {
  const source = unwrapConfigValue(raw)
  if (source === undefined) {
    const defaults = {}
    for (const [prefix, budget] of Object.entries(DEFAULT_BUDGETS)) {
      defaults[prefix] = { ...budget, reminders: [...budget.reminders] }
    }
    return defaults
  }
  const table = source !== null && typeof source === 'object' && !Array.isArray(source) ? source : {}
  const budgets = {}
  for (const prefix of Object.keys(DEFAULT_BUDGETS)) {
    budgets[prefix] = normalizeBudget(table[prefix])
  }
  return budgets
}

function budgetForAgent(name, budgets) {
  if (typeof name !== 'string' || name === '') return undefined
  let matched
  let matchedLength = -1
  for (const [prefix, budget] of Object.entries(budgets ?? {})) {
    if (prefix !== '' && name.startsWith(prefix) && prefix.length > matchedLength) {
      matched = budget
      matchedLength = prefix.length
    }
  }
  return matched
}

let nameWarningLogged = false

function agentNameOf(subagents, agent, namesBySession, ctx) {
  try {
    const sessionId = agent?.session?.id
    if (sessionId !== undefined) {
      const recorded = namesBySession.get(sessionId)
      if (typeof recorded === 'string' && recorded !== '') return recorded
    }
    const self = subagents?.namesOf?.(agent)?.self
    if (typeof self === 'string' && self !== '') {
      try {
        const slash = self.lastIndexOf('/')
        return slash === -1 ? self : self.slice(slash + 1)
      } catch {
        return self
      }
    }
  } catch (error) {
    // Fail open, but not silently: a swallowed error makes probe-/exec-
    // fall back to no prefix budget at all.
    // Warn once per process so this cannot flood the log on every tool call.
    if (!nameWarningLogged) {
      nameWarningLogged = true
      ctx?.logger?.warn?.(
        '[agent-guard] could not resolve the agent name; prefix budgets are not applied: %s',
        String(error),
      )
    }
  }
  return ''
}

// Only `read` counts toward distinct files: grep/glob may walk whole trees and
// their `path` is not a file. Resolve the read file_path and lower-case it on
// Windows so `a.ts`, `.\a.ts` and `A.TS` cannot be counted as three files.
function readPathOf(exec) {
  if (exec?.name !== 'read') return undefined
  const args = exec?.arguments
  const raw = args !== null && typeof args === 'object' ? args.file_path ?? args.filePath : undefined
  if (typeof raw !== 'string' || raw === '') return READ_PATH_PLACEHOLDER
  try {
    const resolved = path.resolve(raw)
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
  } catch {
    return process.platform === 'win32' ? raw.toLowerCase() : raw
  }
}

// Render at most one reminder per step: the highest configured threshold the
// agent has already reached. Re-rendering every step past it is intentional.
function readReminderFor(ctx, subagents, agent, options, stepCounts, readBySession, namesBySession, text) {
  if (agent === undefined || agent === null) return ''
  if (delegationDepth(agent) < 1) return ''
  const budget = budgetForAgent(agentNameOf(subagents, agent, namesBySession, ctx), options.budgets)
  if (budget === undefined || budget.reminders.length === 0) return ''
  const sessionId = agent.session?.id
  if (sessionId === undefined) return ''
  const used = stepCounts.get(sessionId) ?? 0
  let threshold
  for (const value of budget.reminders) {
    if (used >= value && (threshold === undefined || value > threshold)) threshold = value
  }
  if (threshold === undefined) return ''
  const state = readBySession.get(sessionId)
  const calls = state?.calls ?? 0
  const files = state?.files?.size ?? 0
  const remaining = budget.stepBudget > 0 ? Math.max(0, budget.stepBudget - used) : '∞'
  return text('readReminder', used, calls, files, remaining)
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
    budgets: normalizeBudgets(readValue(config, 'budgets')),
    leadNoExecute: readValue(
      config,
      'leadNoExecute',
      readValue(config, 'leadNoWrite', DEFAULTS.leadNoExecute),
    ) === true,
    leadStepBudget: countValue(readValue(config, 'leadStepBudget'), DEFAULTS.leadStepBudget),
    leadSchedulingText: String(readValue(config, 'leadSchedulingText', DEFAULTS.leadSchedulingText)),
    contractText: String(readValue(config, 'contractText', DEFAULTS.contractText)),
    leadReminderText: String(readValue(config, 'leadReminderText', DEFAULTS.leadReminderText)),
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

function refusalFor(ctx, exec, options, stepCounts, filesBySession, ledger, referencedPathsBySession, namesBySession, readBySession, text) {
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

  const budget = budgetForAgent(agentNameOf(ctx.subagents, agent, namesBySession, ctx), options.budgets)
  const stepLimit = budget?.stepBudget ?? 0
  if (stepLimit > 0 && delegationDepth(agent) >= 1) {
    const sessionId = agent.session?.id
    const used = sessionId === undefined ? 0 : (stepCounts.get(sessionId) ?? 0)
    if (used > stepLimit) {
      ctx.logger.info('[agent-guard] child %s reached the step budget %d', String(sessionId).slice(0, 8), stepLimit)
      return text('stepBudget', stepLimit)
    }
  }

  // Read budget: attempt first without committing, so a denied call neither
  // consumes budget nor reaches the concurrency reservation below. Only child
  // agents (depth >= 1) are budgeted, like the step and write budgets.
  if (budget !== undefined && READ_TOOLS.has(exec.name) && delegationDepth(agent) >= 1) {
    const sessionId = agent.session?.id
    if (sessionId !== undefined) {
      const current = readBySession.get(sessionId)
      const usedCalls = current?.calls ?? 0
      const usedFiles = current?.files?.size ?? 0
      const calls = usedCalls + 1
      const files = new Set(current?.files)
      const readPath = readPathOf(exec)
      if (readPath !== undefined) files.add(readPath)
      const overCalls = budget.readCalls > 0 && calls > budget.readCalls
      const overFiles = budget.readFiles > 0 && files.size > budget.readFiles
      if (overCalls || overFiles) {
        ctx.logger.info(
          '[agent-guard] child %s would exceed the read budget: committed calls %d/%d files %d/%d',
          String(sessionId).slice(0, 8), usedCalls, budget.readCalls, usedFiles, budget.readFiles,
        )
        return text('readBudget', usedCalls, usedFiles, budget.readCalls || '∞', budget.readFiles || '∞')
      }
      readBySession.set(sessionId, { calls, files })
    }
  }

  const writeLimit = budget?.writeFiles ?? 0
  if (writeLimit > 0 && delegationDepth(agent) >= 1 && WRITE_TOOLS.has(exec.name)) {
    const sessionId = agent.session?.id
    const path = filePathOf(exec)
    if (sessionId !== undefined && path !== '') {
      const files = filesBySession.get(sessionId) ?? new Set()
      if (!files.has(path)) {
        if (files.size >= writeLimit) {
          ctx.logger.info('[agent-guard] child %s reached the write budget %d', String(sessionId).slice(0, 8), writeLimit)
          return text('writeBudget', files.size, writeLimit)
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
  const stepCounts = new Map()
  const filesBySession = new Map()
  const referencedPathsBySession = new Map()
  const lastInjectedTurnBySession = new Map()
  const namesBySession = new Map()
  const readBySession = new Map()
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
        if (activation?.childId !== undefined && name !== '') namesBySession.set(activation.childId, name)
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
    if (info?.id === undefined) return
    readBySession.delete(info.id)
    namesBySession.delete(info.id)
  })

  ctx.on('agent/disposed', ({ agent }) => {
    const agentId = agent?.id
    if (agentId === undefined) return
    lastInjectedTurnBySession.delete(agentId)
    readBySession.delete(agentId)
    namesBySession.delete(agentId)
  })
  ctx.on('session/event', (session, event) => {
    const id = session?.id
    if (id === undefined) return
    if (event.type === 'turn/start') {
      stepCounts.set(id, 0)
      filesBySession.delete(id)
      readBySession.delete(id)
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
    namesBySession.delete(session.id)
    readBySession.delete(session.id)
    ledger.clearParent(session.id)
    ledger.forgetChild(session.id)
  })

  const language = { value: undefined }
  const CONFIG_TEXT_KEYS = {
    leadScheduling: 'leadSchedulingText',
    contract: 'contractText',
    leadReminder: 'leadReminderText',
  }
  const text = (key, ...args) => {
    const configKey = CONFIG_TEXT_KEYS[key]
    if (configKey !== undefined) {
      const value = resolveOptions(config)[configKey]
      return value.trim() === '' ? DEFAULTS[configKey] : value
    }
    if (language.value === undefined) language.value = readLanguagePreference(ctx) ?? 'zh'
    return COPY[language.value][key](...args)
  }
  ctx.on('settings/document-updated', () => { language.value = undefined })

  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.effect(() => promptCtx.systemPrompt.section({
      name: 'lead-scheduling',
      order: 10300,
      // Reassembled on every model request: only the root (Lead) gets the
      // scheduling protocol, and only while the guard is enabled. Subagents
      // never get it. An empty string means DSH drops the section.
      text: ({ agent }) => {
        if (agent === undefined || agent === null) return ''
        if (resolveOptions(config).enabled !== true) return ''
        return delegationDepth(agent) === 0 ? text('leadScheduling') : ''
      },
    }), 'agent-guard.leadScheduling()')
    // Runtime context, not a section: it is appended after retained history, so
    // the cached system-prompt prefix stays stable and compaction re-sends it.
    const systemPrompt = promptCtx.systemPrompt
    try {
      const order = contractContextOrder(systemPrompt)
      promptCtx.effect(() => systemPrompt.context({
        name: CONTRACT_CONTEXT_NAME,
        order,
        interpolate: false,
        // The guard contract must survive deployments that disable optional
        // runtime context; empty text for root still contributes no snapshot.
        required: true,
        text: ({ agent }) => {
          if (agent === undefined || agent === null) return ''
          if (resolveOptions(config).enabled !== true) return ''
          return delegationDepth(agent) >= 1 ? text('contract') : ''
        },
      }), 'agent-guard.contract()')
    } catch (error) {
      promptCtx.logger?.warn?.('[agent-guard] could not register the subagent contract context: %s', String(error))
    }
    // Registered in its own try/catch so a contract failure cannot silently
    // skip the read-budget reminder or mislabel the failing registration.
    try {
      const order = contractContextOrder(systemPrompt)
      promptCtx.effect(() => systemPrompt.context({
        name: BUDGET_CONTEXT_NAME,
        order: order + 1,
        interpolate: false,
        required: true,
        // Only agents whose name matches a prefix budget get a reminder; the
        // text callback re-reads live counters, so it stays idempotent per step.
        text: ({ agent }) => {
          if (agent === undefined || agent === null) return ''
          const options = resolveOptions(config)
          if (options.enabled !== true) return ''
          return readReminderFor(promptCtx, subagents, agent, options, stepCounts, readBySession, namesBySession, text)
        },
      }), 'agent-guard.readBudget()')
    } catch (error) {
      promptCtx.logger?.warn?.('[agent-guard] could not register the read-budget context: %s', String(error))
    }
  })

  ctx.on('tools/pre-execute', async (exec, next) => {
    const reason = refusalFor(ctx, exec, resolveOptions(config), stepCounts, filesBySession, ledger, referencedPathsBySession, namesBySession, readBySession, text)
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
