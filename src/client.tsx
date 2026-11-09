import React, { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { normalizeGuard } from './guard.ts'
import type { GuardConfig } from './guard.ts'
import en from './locales/en.json'
import zh from './locales/zh.json'
import styles from './styles.css?raw'
import type { ClientContext, ConfigForm, SlotProps, Translate } from './types.ts'

const NS = 'dsh-agent-guard'
const ENTRY_ID = 'agent-guard'
const PANEL_WIDTH = 340
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

type MessageKey = '' | 'saved' | 'saveRefused'

interface PanelProps extends SlotProps {
  form: ConfigForm<GuardConfig>
  t: Translate
  useLocale: () => number
}

function useCurrentRoute(props: SlotProps): { route?: string; model?: string } {
  const useProjection = props.useProjection
  const selection = typeof useProjection === 'function'
    ? (useProjection('modelSelection') as ModelSelectionProjection | undefined)
    : undefined
  const current = selection?.next ?? selection?.lastUsed
  const route = current?.provider !== undefined && current?.model !== undefined
    ? `${current.provider} / ${current.model}`
    : undefined
  return { route, model: current?.model }
}

function useFallbackConfig(props: SlotProps): GuardConfig {
  const useProjection = props.useProjection
  const raw = typeof useProjection === 'function' ? useProjection('agentGuard') : undefined
  return normalizeGuard(raw)
}

// Portal plus fixed positioning keeps the panel outside the composer container; coordinates follow resize and scroll.
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

function Section({ title, children }: { title: string; children: React.ReactNode }): React.ReactElement {
  return (
    <section className="ag-section">
      <div className="ag-section-title">{title}</div>
      {children}
    </section>
  )
}

function GuardDock(props: PanelProps): React.ReactElement {
  const { form, t, useLocale } = props
  useLocale()
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
  const [messageKey, setMessageKey] = useState<MessageKey>('')
  const current = draft ?? stored
  const editable = snapshot.status === 'ready' && snapshot.writable
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(stored)
  const leadDiffers = model !== undefined && model !== current.model

  useEffect(() => {
    if (!open) {
      setDraft(null)
      setMessageKey('')
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
    setMessageKey('')
  }

  const save = async (): Promise<void> => {
    if (draft === null || editable === false) return
    setSaving(true)
    setMessageKey('')
    let accepted = true
    for (const key of Object.keys(draft) as (keyof GuardConfig)[]) {
      if (JSON.stringify(draft[key]) === JSON.stringify(stored[key])) continue
      const ok = await form.set(key, draft[key])
      accepted = ok && accepted
    }
    setSaving(false)
    setDraft(null)
    setMessageKey(accepted ? 'saved' : 'saveRefused')
  }

  return (
    <>
      <button
        ref={anchor}
        type="button"
        className="ag-trigger"
        data-open={open ? 'true' : 'false'}
        aria-expanded={open}
        aria-label={t('triggerAria')}
        title={t('triggerTitle')}
        onClick={() => setOpen(value => !value)}
      >
        <span className="ag-dot" />
        {t('trigger')}
      </button>
      {open && placement !== null
        ? createPortal(
          <div
            ref={panel}
            className="ag-panel"
            role="dialog"
            aria-label={t('dialogAria')}
            style={{ left: placement.left, bottom: placement.bottom, width: PANEL_WIDTH }}
          >
            <div className="ag-head">
              <span className="ag-title">agent-guard</span>
              <span className="ag-state">{current.enabled ? t('stateOn') : t('stateOff')}</span>
            </div>

            <Section title={t('sectionSwitch')}>
              <Field label={t('fieldEnabled')}>
                <input
                  type="checkbox"
                  className="ag-check"
                  checked={current.enabled}
                  disabled={!editable}
                  onChange={event => patch('enabled', event.target.checked)}
                />
              </Field>
              <Field label={t('fieldScope')}>
                <select
                  className="ag-select"
                  value={current.scope}
                  disabled={!editable}
                  onChange={event => patch('scope', event.target.value)}
                >
                  <option value="team">{t('scopeTeam')}</option>
                  <option value="all">{t('scopeAll')}</option>
                </select>
              </Field>
            </Section>

            <Section title={t('sectionSubagent')}>
              <Field label={t('fieldProvider')}>
                <input
                  className="ag-input"
                  value={current.provider}
                  disabled={!editable}
                  onChange={event => patch('provider', event.target.value)}
                />
              </Field>
              <Field label={t('fieldModel')}>
                <input
                  className="ag-input"
                  value={current.model}
                  disabled={!editable}
                  onChange={event => patch('model', event.target.value)}
                />
              </Field>
              <Field label={t('fieldEffort')}>
                <select
                  className="ag-select"
                  value={current.reasoningEffort}
                  disabled={!editable}
                  onChange={event => patch('reasoningEffort', event.target.value)}
                >
                  {REASONING_EFFORTS.map(effort => <option key={effort} value={effort}>{effort}</option>)}
                </select>
              </Field>
            </Section>

            <Section title={t('sectionTeam')}>
              <Field label={t('fieldConcurrency')}>
                <span className="ag-number">
                  <input
                    type="number"
                    min={0}
                    step={1}
                    className="ag-input"
                    value={current.maxConcurrentChildren}
                    disabled={!editable}
                    onChange={event => patch('maxConcurrentChildren', Number(event.target.value))}
                  />
                  <span className="ag-unit">{t('unitCount')}</span>
                </span>
              </Field>
              <Field label={t('fieldBudget')}>
                <span className="ag-number">
                  <input
                    type="number"
                    min={0}
                    step={1}
                    className="ag-input"
                    value={current.stepBudget}
                    disabled={!editable}
                    onChange={event => patch('stepBudget', Number(event.target.value))}
                  />
                  <span className="ag-unit">{t('unitSteps')}</span>
                </span>
              </Field>
              <Field label={t('fieldFiles')}>
                <span className="ag-number">
                  <input
                    type="number"
                    min={0}
                    step={1}
                    className="ag-input"
                    value={current.maxFilesPerAgent}
                    disabled={!editable}
                    onChange={event => patch('maxFilesPerAgent', Number(event.target.value))}
                  />
                  <span className="ag-unit">{t('unitFiles')}</span>
                </span>
              </Field>
              <Field label={t('fieldBanSleep')}>
                <input
                  type="checkbox"
                  className="ag-check"
                  checked={current.banSleepPolling}
                  disabled={!editable}
                  onChange={event => patch('banSleepPolling', event.target.checked)}
                />
              </Field>
            </Section>

            <Section title={t('sectionLead')}>
              <div className="ag-lead">{route ?? t('unknown')}</div>
              {leadDiffers
                ? <div className="ag-diff">{t('leadDiffers', { model: current.model })}</div>
                : null}
            </Section>

            <div className="ag-actions">
              <button
                type="button"
                className="ag-btn primary"
                disabled={!dirty || saving || !editable}
                onClick={() => { void save() }}
              >
                {saving ? t('saving') : t('save')}
              </button>
              <button
                type="button"
                className="ag-btn"
                disabled={!dirty || saving}
                onClick={() => { setDraft(null); setMessageKey('') }}
              >
                {t('reset')}
              </button>
              <span className="ag-msg">{messageKey === '' ? '' : t(messageKey)}</span>
            </div>
            {snapshot.status !== 'ready'
              ? <div className="ag-status">{t('settingsUnavailable')}</div>
              : snapshot.writable === false
                ? <div className="ag-status">{t('readOnly')}</div>
                : null}
            <div className="ag-hint">{t('hint')}</div>
          </div>,
          document.body
        )
        : null}
    </>
  )
}

export const inject = ['slots', 'configForms', 'locale']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.plugin = NS
    style.textContent = styles
    document.head.append(style)
    return () => style.remove()
  }, 'dsh-agent-guard: styles')

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-agent-guard: locales')

  const t = ctx.locale.bind(NS)
  const subscribeLocale = (listener: () => void): (() => void) => ctx.locale.subscribe(listener)
  const getLocaleRevision = (): number => ctx.locale.getSnapshot().revision
  const useLocale = (): number => useSyncExternalStore(subscribeLocale, getLocaleRevision)

  const form = ctx.configForms.get<GuardConfig>(ENTRY_ID)
  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register(
    { name: 'conversation.composer.dock', id: NS, order: 60 },
    (props: SlotProps) => <GuardDock {...props} form={form} t={t} useLocale={useLocale} />
  ))
}
