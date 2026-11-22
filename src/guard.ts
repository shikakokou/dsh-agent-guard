import { CONTRACT, LEAD_REMINDER, LEAD_SCHEDULING } from './prompts.js'

export interface AgentBudget {
  stepBudget: number
  readCalls: number
  readFiles: number
  writeFiles: number
  reminders: number[]
}

export type AgentBudgets = Record<string, AgentBudget>

export interface GuardConfig {
  enabled: boolean
  scope: 'team' | 'all'
  investigateProvider: string
  investigateModel: string
  investigateReasoningEffort: string
  executeProvider: string
  executeModel: string
  executeReasoningEffort: string
  inheritLeadConfig: boolean
  maxConcurrentChildren: number
  banSleepPolling: boolean
  budgets: AgentBudgets
  leadNoExecute: boolean
  leadStepBudget: number
  leadSchedulingText: string
  contractText: string
  leadReminderText: string
}

export const DEFAULT_GUARD: GuardConfig = {
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
  budgets: {
    'probe-': { stepBudget: 20, readCalls: 10, readFiles: 5, writeFiles: 0, reminders: [10] },
    'exec-': { stepBudget: 40, readCalls: 30, readFiles: 20, writeFiles: 0, reminders: [12, 28] }
  },
  leadNoExecute: true,
  leadStepBudget: 24,
  leadSchedulingText: LEAD_SCHEDULING,
  contractText: CONTRACT,
  leadReminderText: LEAD_REMINDER
}

function count(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

// A missing or invalid budget field is 0, which means no limit. This is
// deliberately not merged with any default: only the whole `budgets` table
// being absent selects DEFAULT_GUARD.budgets.
function budgetCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function groupText(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function promptText(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() !== '' ? value : fallback
}

function reminderList(value: unknown): number[] {
  if (!Array.isArray(value)) return []
  const items: number[] = []
  for (const item of value) {
    if (typeof item === 'number' && Number.isFinite(item) && item > 0 && !items.includes(item)) items.push(item)
  }
  return items.sort((left, right) => left - right)
}

function budgetEntry(value: unknown): AgentBudget {
  const entry = value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  return {
    stepBudget: budgetCount(entry.stepBudget),
    readCalls: budgetCount(entry.readCalls),
    readFiles: budgetCount(entry.readFiles),
    writeFiles: budgetCount(entry.writeFiles),
    reminders: reminderList(entry.reminders)
  }
}

function budgets(value: unknown): AgentBudgets {
  if (value === undefined) {
    const defaults: AgentBudgets = {}
    for (const [prefix, budget] of Object.entries(DEFAULT_GUARD.budgets)) {
      defaults[prefix] = { ...budget, reminders: [...budget.reminders] }
    }
    return defaults
  }
  const source = value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  const result: AgentBudgets = {}
  for (const prefix of Object.keys(DEFAULT_GUARD.budgets)) {
    result[prefix] = budgetEntry(source[prefix])
  }
  return result
}

export function normalizeGuard(raw: unknown): GuardConfig {
  if (raw === null || typeof raw !== 'object') return { ...DEFAULT_GUARD }
  const value = raw as Record<string, unknown>
  return {
    enabled: typeof value.enabled === 'boolean' ? value.enabled : DEFAULT_GUARD.enabled,
    scope: value.scope === 'all' || value.scope === 'team' ? value.scope : DEFAULT_GUARD.scope,
    investigateProvider: groupText(value.investigateProvider, DEFAULT_GUARD.investigateProvider),
    investigateModel: groupText(value.investigateModel, DEFAULT_GUARD.investigateModel),
    investigateReasoningEffort: groupText(
      value.investigateReasoningEffort,
      DEFAULT_GUARD.investigateReasoningEffort,
    ),
    executeProvider: groupText(value.executeProvider, DEFAULT_GUARD.executeProvider),
    executeModel: groupText(value.executeModel, DEFAULT_GUARD.executeModel),
    executeReasoningEffort: groupText(value.executeReasoningEffort, DEFAULT_GUARD.executeReasoningEffort),
    inheritLeadConfig: typeof value.inheritLeadConfig === 'boolean'
      ? value.inheritLeadConfig
      : DEFAULT_GUARD.inheritLeadConfig,
    maxConcurrentChildren: count(value.maxConcurrentChildren, DEFAULT_GUARD.maxConcurrentChildren),
    banSleepPolling: typeof value.banSleepPolling === 'boolean' ? value.banSleepPolling : DEFAULT_GUARD.banSleepPolling,
    budgets: budgets(value.budgets),
    leadNoExecute: typeof value.leadNoExecute === 'boolean'
      ? value.leadNoExecute
      : typeof value.leadNoWrite === 'boolean'
        ? value.leadNoWrite
        : DEFAULT_GUARD.leadNoExecute,
    leadStepBudget: count(value.leadStepBudget, DEFAULT_GUARD.leadStepBudget),
    leadSchedulingText: promptText(value.leadSchedulingText, DEFAULT_GUARD.leadSchedulingText),
    contractText: promptText(value.contractText, DEFAULT_GUARD.contractText),
    leadReminderText: promptText(value.leadReminderText, DEFAULT_GUARD.leadReminderText)
  }
}
