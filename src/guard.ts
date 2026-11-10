export interface GuardConfig {
  enabled: boolean
  scope: 'team' | 'all'
  provider: string
  model: string
  reasoningEffort: string
  maxConcurrentChildren: number
  banSleepPolling: boolean
  stepBudget: number
  maxFilesPerAgent: number
  leadNoWrite: boolean
  leadStepBudget: number
}

export const DEFAULT_GUARD: GuardConfig = {
  enabled: true,
  scope: 'team',
  provider: 'deepseek-account',
  model: 'deepseek-flash',
  reasoningEffort: 'low',
  maxConcurrentChildren: 4,
  banSleepPolling: true,
  stepBudget: 25,
  maxFilesPerAgent: 12,
  leadNoWrite: true,
  leadStepBudget: 24
}

function count(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

function text(value: unknown, fallback: string): string {
  return typeof value === 'string' && value !== '' ? value : fallback
}

export function normalizeGuard(raw: unknown): GuardConfig {
  if (raw === null || typeof raw !== 'object') return { ...DEFAULT_GUARD }
  const value = raw as Record<string, unknown>
  return {
    enabled: typeof value.enabled === 'boolean' ? value.enabled : DEFAULT_GUARD.enabled,
    scope: value.scope === 'all' || value.scope === 'team' ? value.scope : DEFAULT_GUARD.scope,
    provider: text(value.provider, DEFAULT_GUARD.provider),
    model: text(value.model, DEFAULT_GUARD.model),
    reasoningEffort: text(value.reasoningEffort, DEFAULT_GUARD.reasoningEffort),
    maxConcurrentChildren: count(
      value.maxConcurrentChildren ?? value.maxConcurrentTeammates,
      DEFAULT_GUARD.maxConcurrentChildren,
    ),
    banSleepPolling: typeof value.banSleepPolling === 'boolean' ? value.banSleepPolling : DEFAULT_GUARD.banSleepPolling,
    stepBudget: count(value.stepBudget, DEFAULT_GUARD.stepBudget),
    maxFilesPerAgent: count(value.maxFilesPerAgent, DEFAULT_GUARD.maxFilesPerAgent),
    leadNoWrite: typeof value.leadNoWrite === 'boolean' ? value.leadNoWrite : DEFAULT_GUARD.leadNoWrite,
    leadStepBudget: count(value.leadStepBudget, DEFAULT_GUARD.leadStepBudget)
  }
}
