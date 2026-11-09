// 与 index.js 的 DEFAULTS 同构。
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

// Host 投影未就绪时的兜底，与 index.js DEFAULTS 一致。
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

export interface GuardRow {
  readonly label: string
  readonly value: string
  readonly mono?: boolean
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

export function guardRows(config: GuardConfig): GuardRow[] {
  const scope = config.scope === 'all' ? '所有 agent' : '团队模式（父 agent 是 Team Lead）'
  return [
    { label: '强制', value: `${config.provider} / ${config.model}`, mono: true },
    { label: '推理强度', value: config.reasoningEffort },
    { label: '范围', value: scope },
    {
      label: '并发上限',
      value: config.maxConcurrentTeammates > 0 ? `${config.maxConcurrentTeammates} 个 teammate` : '关闭'
    },
    { label: 'sleep 轮询', value: config.banSleepPolling ? '禁止（团队活跃时）' : '允许' },
    { label: '步数预算', value: config.stepBudget > 0 ? `${config.stepBudget} 步 / 轮` : '关闭' }
  ]
}
