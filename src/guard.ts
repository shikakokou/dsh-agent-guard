/** 浮窗展示用的约束参数；与 Host 半边 `index.js` 的 DEFAULTS 保持一致。 */
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

export const GUARD: GuardConfig = {
  enabled: true,
  scope: 'team',
  provider: 'deepseek-account',
  model: 'deepseek-flash',
  reasoningEffort: 'low',
  maxConcurrentTeammates: 4,
  banSleepPolling: true,
  stepBudget: 25
}

/** 浮窗里的一行。 */
export interface GuardRow {
  readonly label: string
  readonly value: string
  readonly mono?: boolean
}

/**
 * 由常量生成浮窗行，避免 JSX 里堆条件判断。
 * @returns 固定的约束展示行（当前 Lead 单独渲染）。
 */
export function guardRows(): GuardRow[] {
  const scope = GUARD.scope === 'all' ? '所有 agent' : '团队模式（父 agent 是 Team Lead）'
  return [
    { label: '强制', value: `${GUARD.provider} / ${GUARD.model}`, mono: true },
    { label: '推理强度', value: GUARD.reasoningEffort },
    { label: '范围', value: scope },
    {
      label: '并发上限',
      value: GUARD.maxConcurrentTeammates > 0 ? `${GUARD.maxConcurrentTeammates} 个 teammate` : '关闭'
    },
    { label: 'sleep 轮询', value: GUARD.banSleepPolling ? '禁止（团队活跃时）' : '允许' },
    { label: '步数预算', value: GUARD.stepBudget > 0 ? `${GUARD.stepBudget} 步 / 轮` : '关闭' }
  ]
}
