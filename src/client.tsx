import React, { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { DEFAULT_GUARD, normalizeGuard } from './guard.ts'
import type { GuardConfig } from './guard.ts'
import en from './locales/en.json'
import zh from './locales/zh.json'
import { computePlacement } from './placement.ts'
import type { Placement } from './placement.ts'
import styles from './styles.css?raw'
import type { ClientContext, ConfigForm, SlotProps, Translate } from './types.ts'

const NS = 'dsh-agent-guard'
const ENTRY_ID = 'agent-guard'
const PANEL_WIDTH = 340
const REASONING_EFFORTS = ['off', 'low', 'high', 'max'] as const

interface ModelSelectionView {
  provider?: string
  model?: string
}

interface ModelSelectionProjection {
  next?: ModelSelectionView
  lastUsed?: ModelSelectionView
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

function useAnchorPlacement(
  open: boolean,
  anchor: React.RefObject<HTMLButtonElement | null>,
  panel: React.RefObject<HTMLDivElement | null>
): Placement | null {
  const [placement, setPlacement] = useState<Placement | null>(null)

  useLayoutEffect(() => {
    if (!open) {
      setPlacement(null)
      return undefined
    }
    const place = (): void => {
      const element = panel.current
      const trigger = anchor.current
      if (element === null || trigger === null) return
      const rect = trigger.getBoundingClientRect()
      let height = element.offsetHeight
      for (const child of Array.from(element.children)) {
        if (!(child instanceof HTMLElement)) continue
        height += Math.max(0, child.scrollHeight - child.clientHeight)
      }
      const next = computePlacement(
        { left: rect.left, top: rect.top, bottom: rect.bottom, right: rect.right },
        { width: element.offsetWidth || PANEL_WIDTH, height },
        { width: window.innerWidth, height: window.innerHeight }
      )
      setPlacement(current =>
        current !== null &&
        current.left === next.left &&
        current.top === next.top &&
        current.maxHeight === next.maxHeight
          ? current
          : next
      )
    }
    place()
    const onScroll = (event: Event): void => {
      if (event.target instanceof Node && panel.current?.contains(event.target) === true) return
      place()
    }
    window.addEventListener('resize', place)
    window.addEventListener('scroll', onScroll, true)
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(place) : null
    if (panel.current !== null) observer?.observe(panel.current)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', onScroll, true)
      observer?.disconnect()
    }
  }, [open, anchor, panel])

  return placement
}

const HELP_TIP_WIDTH = 240

function HelpTip({ text }: { text: string }): React.ReactElement {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<{ left: number; top: number; below: boolean } | null>(null)
  const iconRef = useRef<HTMLSpanElement | null>(null)
  const show = () => {
    const rect = iconRef.current?.getBoundingClientRect()
    if (rect === undefined) return
    const width = Math.min(HELP_TIP_WIDTH, window.innerWidth - 16)
    const left = Math.max(8, Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - 8))
    const below = rect.top < 180
    setPosition({ left, top: below ? rect.bottom + 6 : rect.top - 6, below })
    setOpen(true)
  }
  const hide = () => setOpen(false)
  return (
    <>
      <span
        ref={iconRef}
        className="ag-help"
        role="button"
        tabIndex={0}
        aria-label={text}
        aria-expanded={open}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onClick={event => { event.preventDefault(); event.stopPropagation() }}
        onKeyDown={event => { if (event.key === ' ' || event.key === 'Enter') event.preventDefault() }}
      >
        <svg
          viewBox="0 0 24 24"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="10" />
          <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
          <path d="M12 17h.01" />
        </svg>
      </span>
      {open && position !== null
        ? createPortal(
          <span
            className="ag-help-tip"
            role="tooltip"
            style={{
              left: position.left,
              top: position.top,
              width: Math.min(HELP_TIP_WIDTH, window.innerWidth - 16),
              transform: position.below ? undefined : 'translateY(-100%)',
            }}
          >{text}</span>,
          document.body,
        )
        : null}
    </>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }): React.ReactElement {
  return (
    <label className="ag-field">
      <span className="ag-field-label">
        {label}
        {hint !== undefined ? <HelpTip text={hint} /> : null}
      </span>
      {children}
    </label>
  )
}

function EffortField(props: {
  label: string
  value: string
  disabled: boolean
  onChange: (value: string) => void
  t: Translate
}): React.ReactElement {
  const { label, value, disabled, onChange, t } = props
  const [custom, setCustom] = useState(
    () => !REASONING_EFFORTS.includes(value as typeof REASONING_EFFORTS[number])
  )
  return (
    <Field label={label}>
      {custom ? (
        <span className="ag-effort-custom">
          <input
            className="ag-input"
            value={value}
            disabled={disabled}
            placeholder={t('effortPlaceholder')}
            autoFocus
            onChange={event => onChange(event.target.value)}
            onKeyDown={event => { if (event.key === 'Enter') setCustom(false) }}
          />
          <button
            type="button"
            className="ag-effort-presets"
            disabled={disabled}
            onClick={() => {
              setCustom(false)
              if (!REASONING_EFFORTS.includes(value as typeof REASONING_EFFORTS[number])) {
                onChange('low')
              }
            }}
          >{t('effortPresets')}</button>
        </span>
      ) : (
        <select
          className="ag-select"
          value={value}
          disabled={disabled}
          onChange={event => {
            if (event.target.value === '__custom__') {
              setCustom(true)
              return
            }
            onChange(event.target.value)
          }}
        >
          {REASONING_EFFORTS.map(effort => <option key={effort} value={effort}>{effort}</option>)}
          {!REASONING_EFFORTS.includes(value as typeof REASONING_EFFORTS[number])
            ? <option value={value}>{value}</option>
            : null}
          <option value="__custom__">{t('effortCustom')}</option>
        </select>
      )}
    </Field>
  )
}

function Section({ title, hint, children }: {
  title: string
  hint?: string
  children: React.ReactNode
}): React.ReactElement {
  return (
    <section className="ag-section">
      <div className="ag-section-head">
        <span className="ag-section-title">{title}</span>
        {hint === undefined ? null : <span className="ag-note ag-section-hint">{hint}</span>}
      </div>
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
  const placement = useAnchorPlacement(open, anchor, panel)
  const { route } = useCurrentRoute(props)
  const fallback = useFallbackConfig(props)

  const subscribe = useCallback((listener: () => void) => form.subscribe(listener), [form])
  const getSnapshot = useCallback(() => form.getSnapshot(), [form])
  const snapshot = useSyncExternalStore(subscribe, getSnapshot)

  const stored = normalizeGuard(snapshot.value ?? fallback)
  const [draft, setDraft] = useState<GuardConfig | null>(null)
  const [saving, setSaving] = useState(false)
  const [messageKey, setMessageKey] = useState<MessageKey>('')
  const current = draft ?? stored
  const editable = snapshot.status === 'ready' && snapshot.writable
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(stored)

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
        data-enabled={current.enabled ? 'true' : 'false'}
        aria-expanded={open}
        aria-label={t('triggerAria')}
        title={t('triggerTitle')}
        onClick={() => setOpen(value => !value)}
      >
        <span className="ag-dot" />
        {t('trigger')}
      </button>
      {open
        ? createPortal(
          <div
            ref={panel}
            className="ag-panel"
            data-enabled={current.enabled ? 'true' : 'false'}
            role="dialog"
            aria-label={t('dialogAria')}
            style={placement === null
              ? { left: 0, top: 0, width: PANEL_WIDTH, visibility: 'hidden' }
              : { left: placement.left, top: placement.top, maxHeight: placement.maxHeight, width: PANEL_WIDTH }}
          >
            <div className="ag-head">
              <span className="ag-title">agent-guard</span>
              <span className="ag-state">{current.enabled ? t('stateOn') : t('stateOff')}</span>
            </div>

            <div className="ag-body">
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
              <Field label={t('fieldInheritLead')}>
                <input
                  type="checkbox"
                  className="ag-check"
                  checked={current.inheritLeadConfig}
                  disabled={!editable}
                  onChange={event => patch('inheritLeadConfig', event.target.checked)}
                />
              </Field>
            </Section>

            <Section title={t('sectionModelGroups')} hint={t('modelGroupsHint')}>
              <div className="ag-note ag-note-left">{t('groupInvestigate')}</div>
              <Field label={t('fieldProvider')}>
                <input
                  className="ag-input"
                  value={current.investigateProvider || DEFAULT_GUARD.investigateProvider}
                  disabled={!editable}
                  onChange={event => patch('investigateProvider', event.target.value)}
                />
              </Field>
              <Field label={t('fieldModel')}>
                <input
                  className="ag-input"
                  value={current.investigateModel || DEFAULT_GUARD.investigateModel}
                  disabled={!editable}
                  onChange={event => patch('investigateModel', event.target.value)}
                />
              </Field>
              <EffortField label={t('fieldEffort')} value={current.investigateReasoningEffort || DEFAULT_GUARD.investigateReasoningEffort} disabled={!editable} onChange={value => patch('investigateReasoningEffort', value)} t={t} />
              <div className="ag-note ag-note-left">{t('groupExecute')}</div>
              <Field label={t('fieldProvider')}>
                <input
                  className="ag-input"
                  value={current.executeProvider || DEFAULT_GUARD.executeProvider}
                  disabled={!editable}
                  onChange={event => patch('executeProvider', event.target.value)}
                />
              </Field>
              <Field label={t('fieldModel')}>
                <input
                  className="ag-input"
                  value={current.executeModel || DEFAULT_GUARD.executeModel}
                  disabled={!editable}
                  onChange={event => patch('executeModel', event.target.value)}
                />
              </Field>
              <EffortField label={t('fieldEffort')} value={current.executeReasoningEffort || DEFAULT_GUARD.executeReasoningEffort} disabled={!editable} onChange={value => patch('executeReasoningEffort', value)} t={t} />
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
              <div className="ag-note">{t('zeroUnlimited')}</div>
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
              <div className="ag-note">{t('zeroUnlimited')}</div>
              <Field label={t('fieldBanSleep')}>
                <input
                  type="checkbox"
                  className="ag-check"
                  checked={current.banSleepPolling}
                  disabled={!editable}
                  onChange={event => patch('banSleepPolling', event.target.checked)}
                />
              </Field>
              <Field label={t('fieldLeadExecute')} hint={t('leadExecuteHint')}>
                <input
                  type="checkbox"
                  className="ag-check"
                  checked={current.leadNoExecute}
                  disabled={!editable}
                  onChange={event => patch('leadNoExecute', event.target.checked)}
                />
              </Field>
              <Field label={t('fieldLeadBudget')}>
                <span className="ag-number">
                  <input
                    type="number"
                    min={0}
                    step={1}
                    className="ag-input"
                    value={current.leadStepBudget}
                    disabled={!editable}
                    onChange={event => patch('leadStepBudget', Number(event.target.value))}
                  />
                  <span className="ag-unit">{t('unitSteps')}</span>
                </span>
              </Field>
              <div className="ag-note">{t('zeroUnlimited')}</div>
            </Section>
            </div>

            <div className="ag-foot">
              <Section title={t('sectionLead')}>
                <div className="ag-lead">{route ?? t('unknown')}</div>
              </Section>

              {snapshot.status !== 'ready'
                ? <div className="ag-status">{t('settingsUnavailable')}</div>
                : snapshot.writable === false
                  ? <div className="ag-status">{t('readOnly')}</div>
                  : null}
              <div className="ag-hint">{t('hint')}</div>
            </div>

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
                onClick={() => { setDraft({ ...DEFAULT_GUARD }); setMessageKey('') }}
              >
                {t('reset')}
              </button>
              <span className="ag-msg">{messageKey === '' ? '' : t(messageKey)}</span>
            </div>
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
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register(
    { name: 'conversation.input.left', id: NS, order: 40 },
    (props: SlotProps) => <GuardDock {...props} form={form} t={t} useLocale={useLocale} />
  ))
}
