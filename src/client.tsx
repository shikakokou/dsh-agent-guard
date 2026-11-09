import React, { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { normalizeGuard } from './guard.ts'
import type { GuardConfig } from './guard.ts'
import styles from './styles.css?raw'
import type { ClientContext, ConfigForm, SlotProps } from './types.ts'

const NS = 'dsh-agent-guard'
const ENTRY_ID = 'agent-guard'
const PANEL_WIDTH = 320
const VIEWPORT_MARGIN = 8
const REASONING_EFFORTS = ['off', 'low', 'high', 'max'] as const

interface ModelSelectionView {
  provider?: string
  model?: string
}

interface ModelSelectionProjection {
  next?: ModelSelectionView
  lastUsed?: ModelSelectionView
}

interface Placement {
  left: number
  bottom: number
}

function useCurrentRoute(props: SlotProps): { route: string; model?: string } {
  const useProjection = props.useProjection
  const selection = typeof useProjection === 'function'
    ? (useProjection('modelSelection') as ModelSelectionProjection | undefined)
    : undefined
  const current = selection?.next ?? selection?.lastUsed
  const route = current?.provider !== undefined && current?.model !== undefined
    ? `${current.provider} / ${current.model}`
    : '未知'
  return { route, model: current?.model }
}

function useFallbackConfig(props: SlotProps): GuardConfig {
  const useProjection = props.useProjection
  const raw = typeof useProjection === 'function' ? useProjection('agentGuard') : undefined
  return normalizeGuard(raw)
}

// portal + fixed：避免被 composer 容器裁切，坐标随 resize/scroll 重算。
function useAnchorPlacement(
  open: boolean,
  anchor: React.RefObject<HTMLButtonElement | null>
): Placement | null {
  const [placement, setPlacement] = useState<Placement | null>(null)

  const measure = useCallback(() => {
    const element = anchor.current
    if (element === null) return
    const rect = element.getBoundingClientRect()
    const maxLeft = Math.max(VIEWPORT_MARGIN, window.innerWidth - PANEL_WIDTH - VIEWPORT_MARGIN)
    setPlacement({
      left: Math.min(Math.max(rect.left, VIEWPORT_MARGIN), maxLeft),
      bottom: Math.max(window.innerHeight - rect.top + 8, VIEWPORT_MARGIN)
    })
  }, [anchor])

  useLayoutEffect(() => {
    if (open) measure()
  }, [open, measure])

  useEffect(() => {
    if (!open) return undefined
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => {
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [open, measure])

  return placement
}

function Field({ label, children }: { label: string; children: React.ReactNode }): React.ReactElement {
  return (
    <label className="ag-field">
      <span className="ag-field-label">{label}</span>
      {children}
    </label>
  )
}

function GuardDock(props: SlotProps & { form: ConfigForm<GuardConfig> }): React.ReactElement {
  const { form } = props
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const placement = useAnchorPlacement(open, anchor)
  const { route, model } = useCurrentRoute(props)
  const fallback = useFallbackConfig(props)

  const subscribe = useCallback((listener: () => void) => form.subscribe(listener), [form])
  const getSnapshot = useCallback(() => form.getSnapshot(), [form])
  const snapshot = useSyncExternalStore(subscribe, getSnapshot)

  const stored = snapshot.value ?? fallback
  const [draft, setDraft] = useState<GuardConfig | null>(null)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const current = draft ?? stored
  const editable = snapshot.status === 'ready' && snapshot.writable
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(stored)
  const leadDiffers = model !== undefined && model !== current.model

  useEffect(() => {
    if (!open) {
      setDraft(null)
      setMessage('')
    }
  }, [open])

  useEffect(() => {
    if (!open) return undefined
    const onPointerDown = (event: MouseEvent): void => {
      const target = event.target as Node | null
      if (target === null) return
      if (anchor.current?.contains(target) === true) return
      if (panel.current?.contains(target) === true) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [open])

  const patch = (key: keyof GuardConfig, value: unknown): void => {
    setDraft(previous => ({ ...(previous ?? stored), [key]: value }))
    setMessage('')
  }

  const save = async (): Promise<void> => {
    if (draft === null || editable === false) return
    setSaving(true)
    setMessage('')
    let accepted = true
    for (const key of Object.keys(draft) as (keyof GuardConfig)[]) {
      if (JSON.stringify(draft[key]) === JSON.stringify(stored[key])) continue
      const ok = await form.set(key, draft[key])
      accepted = ok && accepted
    }
    setSaving(false)
    setDraft(null)
    setMessage(accepted ? '已保存，立即生效' : '保存被拒绝')
  }

  return (
    <>
      <button
        ref={anchor}
        type="button"
        className="ag-trigger"
        data-open={open ? 'true' : 'false'}
        aria-expanded={open}
        aria-label="agent-guard 状态与配置"
        title="agent-guard：查看并修改 agent 行为约束"
        onClick={() => setOpen(value => !value)}
      >
        <span className="ag-dot" />
        Guard
      </button>
      {open && placement !== null
        ? createPortal(
          <div
            ref={panel}
            className="ag-panel"
            role="dialog"
            aria-label="agent-guard 配置"
            style={{ left: placement.left, bottom: placement.bottom, width: PANEL_WIDTH }}
          >
            <div className="ag-head">
              <span className="ag-title">agent-guard</span>
              <span className="ag-state">{current.enabled ? '生效中' : '已停用'}</span>
            </div>
            <div className="ag-sep" />

            <Field label="启用">
              <input
                type="checkbox"
                className="ag-check"
                checked={current.enabled}
                disabled={!editable}
                onChange={event => patch('enabled', event.target.checked)}
              />
            </Field>
            <Field label="强制">
              <input
                className="ag-input"
                value={current.provider}
                disabled={!editable}
                onChange={event => patch('provider', event.target.value)}
              />
            </Field>
            <Field label="模型">
              <input
                className="ag-input"
                value={current.model}
                disabled={!editable}
                onChange={event => patch('model', event.target.value)}
              />
            </Field>
            <Field label="推理强度">
              <select
                className="ag-select"
                value={current.reasoningEffort}
                disabled={!editable}
                onChange={event => patch('reasoningEffort', event.target.value)}
              >
                {REASONING_EFFORTS.map(effort => <option key={effort} value={effort}>{effort}</option>)}
              </select>
            </Field>
            <Field label="范围">
              <select
                className="ag-select"
                value={current.scope}
                disabled={!editable}
                onChange={event => patch('scope', event.target.value)}
              >
                <option value="team">team（仅团队）</option>
                <option value="all">all（所有 agent）</option>
              </select>
            </Field>
            <Field label="并发上限">
              <input
                type="number"
                min={0}
                step={1}
                className="ag-input"
                value={current.maxConcurrentTeammates}
                disabled={!editable}
                onChange={event => patch('maxConcurrentTeammates', Number(event.target.value))}
              />
            </Field>
            <Field label="步数预算">
              <input
                type="number"
                min={0}
                step={1}
                className="ag-input"
                value={current.stepBudget}
                disabled={!editable}
                onChange={event => patch('stepBudget', Number(event.target.value))}
              />
            </Field>
            <Field label="禁 sleep">
              <input
                type="checkbox"
                className="ag-check"
                checked={current.banSleepPolling}
                disabled={!editable}
                onChange={event => patch('banSleepPolling', event.target.checked)}
              />
            </Field>

            <div className="ag-row">
              <span className="ag-label">当前 Lead</span>
              <span className="ag-value">{route}</span>
            </div>
            {leadDiffers
              ? <div className="ag-diff">Lead 当前不是 {current.model}，子智能体仍会按上面的参数启动。</div>
              : null}

            <div className="ag-actions">
              <button
                type="button"
                className="ag-btn primary"
                disabled={!dirty || saving || !editable}
                onClick={() => { void save() }}
              >
                {saving ? '保存中…' : '保存'}
              </button>
              <button
                type="button"
                className="ag-btn"
                disabled={!dirty || saving}
                onClick={() => { setDraft(null); setMessage('') }}
              >
                重置
              </button>
              <span className="ag-msg">{message}</span>
            </div>
            {snapshot.status !== 'ready'
              ? <div className="ag-status">设置服务不可用（Host 未提供 agent-guard 配置）；只能查看不能改。</div>
              : snapshot.writable === false
                ? <div className="ag-status">当前配置只读。</div>
                : null}
            <div className="ag-hint">改动写入 profile 的 cordis.patch.yml，保存后立即生效；浮窗刷新页面后显示同值。</div>
          </div>,
          document.body
        )
        : null}
    </>
  )
}

export const inject = ['slots', 'configForms']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.plugin = NS
    style.textContent = styles
    document.head.append(style)
    return () => style.remove()
  }, 'dsh-agent-guard: styles')

  const form = ctx.configForms.get<GuardConfig>(ENTRY_ID)
  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register(
    { name: 'conversation.composer.dock', id: NS, order: 60 },
    (props: SlotProps) => <GuardDock {...props} form={form} />
  ))
}
