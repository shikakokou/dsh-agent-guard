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
  stepBudget: number
  maxFilesPerAgent: number
  leadNoExecute: boolean
  leadStepBudget: number
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
  stepBudget: 40,
  maxFilesPerAgent: 24,
  leadNoExecute: true,
  leadStepBudget: 24
}

function count(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

function groupText(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
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
    stepBudget: count(value.stepBudget, DEFAULT_GUARD.stepBudget),
    maxFilesPerAgent: count(value.maxFilesPerAgent, DEFAULT_GUARD.maxFilesPerAgent),
    leadNoExecute: typeof value.leadNoExecute === 'boolean'
      ? value.leadNoExecute
      : typeof value.leadNoWrite === 'boolean'
        ? value.leadNoWrite
        : DEFAULT_GUARD.leadNoExecute,
    leadStepBudget: count(value.leadStepBudget, DEFAULT_GUARD.leadStepBudget)
  }
}
