// 与 index.js 的 Config 默认值同构。
export interface GuardConfig {
  enabled: boolean
  scope: 'team' | 'all'
  provider: string
  model: string
  reasoningEffort: string
  maxConcurrentTeammates: number
  banSleepPolling: boolean
  stepBudget: number
}

// 设置服务暂不可用时的兜底，与 index.js DEFAULTS 一致。
export const DEFAULT_GUARD: GuardConfig = {
  enabled: true,
  scope: 'team',
  provider: 'deepseek-account',
  model: 'deepseek-flash',
  reasoningEffort: 'low',
  maxConcurrentTeammates: 4,
  banSleepPolling: true,
  stepBudget: 25
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
    maxConcurrentTeammates: count(value.maxConcurrentTeammates, DEFAULT_GUARD.maxConcurrentTeammates),
    banSleepPolling: typeof value.banSleepPolling === 'boolean' ? value.banSleepPolling : DEFAULT_GUARD.banSleepPolling,
    stepBudget: count(value.stepBudget, DEFAULT_GUARD.stepBudget)
  }
}
