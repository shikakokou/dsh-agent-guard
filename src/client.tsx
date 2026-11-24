import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { DEFAULT_GUARD, normalizeGuard } from './guard.ts'
import type { AgentBudget, GuardConfig } from './guard.ts'
import en from './locales/en.json'
import zh from './locales/zh.json'
import styles from './styles.css?raw'
import type { ClientContext, ConfigForm, SlotProps, Translate } from './types.ts'

const NS = 'dsh-agent-guard'
const ENTRY_ID = 'agent-guard'
const DRAWER_EXIT_MS = 220
const TEXT_KEYS: ReadonlySet<keyof GuardConfig> = new Set([
  'leadSchedulingText',
  'contractText',
  'leadReminderText',
])
const REASONING_EFFORTS = ['off', 'low', 'high', 'max'] as const
const TABS = [
  { key: 'general', label: 'tabGeneral' },
  { key: 'prompt', label: 'tabPrompt' },
  { key: 'rules', label: 'tabRules' },
] as const
type TabKey = typeof TABS[number]['key']
const BUDGET_PREFIXES = ['probe-', 'exec-'] as const

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

function Field({ label, hint, children, labelClassName }: { label: string; hint?: string; children: React.ReactNode; labelClassName?: string }): React.ReactElement {
  return (
    <label className="ag-field">
      <span className={labelClassName === undefined ? 'ag-field-label' : `ag-field-label ${labelClassName}`}>
        {label}
        {hint !== undefined ? <HelpTip text={hint} /> : null}
      </span>
      {children}
    </label>
  )
}

function TextAreaField(props: {
  label: string
  hint?: string
  rows: number
  value: string
  disabled: boolean
  onChange: (value: string) => void
}): React.ReactElement {
  const { label, hint, rows, value, disabled, onChange } = props
  return (
    <label className="ag-field ag-field-block">
      <span className="ag-field-label">{label}</span>
      <textarea
        className="ag-textarea"
        rows={rows}
        value={value}
        disabled={disabled}
        spellCheck={false}
        onChange={event => onChange(event.target.value)}
      />
      {hint === undefined ? null : <span className="ag-field-hint">{hint}</span>}
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

function parseReminders(raw: string): number[] {
  const reminders: number[] = []
  for (const token of raw.split(',')) {
    const text = token.trim()
    if (!/^\d+$/.test(text)) continue
    const step = Number(text)
    if (step > 0 && !reminders.includes(step)) reminders.push(step)
  }
  return reminders.sort((left, right) => left - right)
}

function BudgetNumberInput(props: {
  value: number
  disabled: boolean
  ariaLabel: string
  onChange: (value: number) => void
}): React.ReactElement {
  const { value, disabled, ariaLabel, onChange } = props
  const [text, setText] = useState(() => String(value))
  const lastEmitted = useRef(value)
  useEffect(() => {
    if (lastEmitted.current === value) return
    lastEmitted.current = value
    setText(String(value))
  }, [value])
  const commit = (raw: string): void => {
    const next = raw === '' ? 0 : Number(raw)
    lastEmitted.current = next
    onChange(next)
  }
  return (
    <input
      type="text"
      inputMode="numeric"
      autoComplete="off"
      className="ag-input ag-budget-input"
      value={text}
      disabled={disabled}
      aria-label={ariaLabel}
      onChange={event => {
        const raw = event.target.value
        if (!/^\d*$/.test(raw)) return
        setText(raw)
        commit(raw)
      }}
      onBlur={() => setText(String(value))}
    />
  )
}

function RemindersInput(props: {
  value: number[]
  disabled: boolean
  ariaLabel: string
  onChange: (value: number[]) => void
}): React.ReactElement {
  const { value, disabled, ariaLabel, onChange } = props
  const [text, setText] = useState(() => value.join(','))
  const lastEmitted = useRef(value.join(','))
  useEffect(() => {
    const next = value.join(',')
    if (lastEmitted.current === next) return
    lastEmitted.current = next
    setText(next)
  }, [value])
  const commit = (raw: string): void => {
    const reminders = parseReminders(raw)
    lastEmitted.current = reminders.join(',')
    onChange(reminders)
  }
  return (
    <input
      type="text"
      inputMode="numeric"
      autoComplete="off"
      className="ag-input ag-budget-input"
      value={text}
      disabled={disabled}
      aria-label={ariaLabel}
      onChange={event => {
        const raw = event.target.value
        if (!/^[\d,\s]*$/.test(raw)) return
        setText(raw)
        commit(raw)
      }}
      onBlur={() => {
        const reminders = parseReminders(text)
        lastEmitted.current = reminders.join(',')
        setText(reminders.join(','))
        onChange(reminders)
      }}
    />
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
  const [present, setPresent] = useState(false)
  const [visible, setVisible] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const wasOpen = useRef(false)
  const { route } = useCurrentRoute(props)
  const fallback = useFallbackConfig(props)

  const subscribe = useCallback((listener: () => void) => form.subscribe(listener), [form])
  const getSnapshot = useCallback(() => form.getSnapshot(), [form])
  const snapshot = useSyncExternalStore(subscribe, getSnapshot)

  const stored = normalizeGuard(snapshot.value ?? fallback)
  const [draft, setDraft] = useState<GuardConfig | null>(null)
  const [tab, setTab] = useState<TabKey>('general')
  const [saving, setSaving] = useState(false)
  const [messageKey, setMessageKey] = useState<MessageKey>('')
  const current = draft ?? stored
  const editable = snapshot.status === 'ready' && snapshot.writable
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(stored)

  useEffect(() => {
    if (open) {
      setPresent(true)
      const frame = window.requestAnimationFrame(() => setVisible(true))
      return () => window.cancelAnimationFrame(frame)
    }
    setVisible(false)
    const timer = window.setTimeout(() => setPresent(false), DRAWER_EXIT_MS)
    return () => window.clearTimeout(timer)
  }, [open])

  useEffect(() => {
    if (open) {
      wasOpen.current = true
      if (visible) panel.current?.focus()
      return
    }
    if (wasOpen.current) {
      wasOpen.current = false
      anchor.current?.focus()
    }
  }, [open, visible])

  useEffect(() => {
    if (!open) return undefined
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [open])

  const patch = (key: keyof GuardConfig, value: unknown): void => {
    setDraft(previous => ({ ...(previous ?? stored), [key]: value }))
    setMessageKey('')
  }

  const budgetFor = (prefix: string): AgentBudget => current.budgets[prefix] ?? DEFAULT_GUARD.budgets[prefix]

  const patchBudget = (prefix: string, key: keyof AgentBudget, value: number | number[]): void => {
    setDraft(previous => {
      const base = previous ?? stored
      return {
        ...base,
        budgets: {
          ...base.budgets,
          [prefix]: { ...(base.budgets[prefix] ?? DEFAULT_GUARD.budgets[prefix]), [key]: value },
        },
      }
    })
    setMessageKey('')
  }

  const onTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number): void => {
    let next = -1
    if (event.key === 'ArrowRight') next = (index + 1) % TABS.length
    else if (event.key === 'ArrowLeft') next = (index - 1 + TABS.length) % TABS.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = TABS.length - 1
    if (next < 0) return
    event.preventDefault()
    setTab(TABS[next].key)
    document.getElementById(`ag-tab-${TABS[next].key}`)?.focus()
  }

  const save = async (): Promise<void> => {
    if (draft === null || editable === false) return
    setSaving(true)
    setMessageKey('')
    let accepted = true
    for (const key of Object.keys(draft) as (keyof GuardConfig)[]) {
      if (JSON.stringify(draft[key]) === JSON.stringify(stored[key])) continue
      const value = draft[key]
      const clear = TEXT_KEYS.has(key) && typeof value === 'string' && value.trim() === ''
      const ok = clear ? await form.unset(key) : await form.set(key, value)
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
      {present
        ? createPortal(
          <>
            <div
              className="ag-backdrop"
              data-open={visible ? 'true' : 'false'}
              aria-hidden="true"
              onClick={() => setOpen(false)}
            />
            <div
              ref={panel}
              className="ag-drawer"
              data-open={visible ? 'true' : 'false'}
              data-enabled={current.enabled ? 'true' : 'false'}
              role="dialog"
              aria-modal="true"
              aria-label={t('dialogAria')}
              tabIndex={-1}
            >
              <div className="ag-drawer-head">
                <span className="ag-title">{t('drawerTitle')}</span>
                <span className="ag-state">{current.enabled ? t('stateOn') : t('stateOff')}</span>
                <button
                  type="button"
                  className="ag-drawer-close"
                  aria-label={t('close')}
                  title={t('close')}
                  onClick={() => setOpen(false)}
                >
                  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
                    <path d="M4 4l8 8M12 4l-8 8" />
                  </svg>
                </button>
              </div>

              <div className="ag-tabs" role="tablist" aria-label={t('drawerTitle')}>
                {TABS.map((item, index) => (
                  <button
                    key={item.key}
                    id={`ag-tab-${item.key}`}
                    type="button"
                    role="tab"
                    className="ag-tab"
                    aria-selected={tab === item.key}
                    aria-controls={`ag-panel-${item.key}`}
                    tabIndex={tab === item.key ? 0 : -1}
                    data-active={tab === item.key ? 'true' : 'false'}
                    onClick={() => setTab(item.key)}
                    onKeyDown={event => onTabKeyDown(event, index)}
                  >{t(item.label)}</button>
                ))}
              </div>

              <div className="ag-drawer-body">
            {tab === 'general' ? (
            <div className="ag-tab-panel" role="tabpanel" id="ag-panel-general" aria-labelledby="ag-tab-general">
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
              <Field label={t('fieldBanSleep')}>
                <input
                  type="checkbox"
                  className="ag-check"
                  checked={current.banSleepPolling}
                  disabled={!editable}
                  onChange={event => patch('banSleepPolling', event.target.checked)}
                />
              </Field>
              <Field label={t('fieldLeadExecute')} hint={t('leadExecuteHint')} labelClassName="ag-lead-no-execute">
                <input
                  type="checkbox"
                  className="ag-check"
                  checked={current.leadNoExecute}
                  disabled={!editable}
                  onChange={event => patch('leadNoExecute', event.target.checked)}
                />
              </Field>
            </Section>
            </div>
            ) : tab === 'prompt' ? (
            <div className="ag-tab-panel" role="tabpanel" id="ag-panel-prompt" aria-labelledby="ag-tab-prompt">
              <TextAreaField
                label={t('fieldLeadSchedulingText')}
                hint={t('leadSchedulingHint')}
                rows={8}
                value={current.leadSchedulingText}
                disabled={!editable}
                onChange={value => patch('leadSchedulingText', value)}
              />
              <TextAreaField
                label={t('fieldContractText')}
                hint={t('contractHint')}
                rows={12}
                value={current.contractText}
                disabled={!editable}
                onChange={value => patch('contractText', value)}
              />
              <TextAreaField
                label={t('fieldLeadReminderText')}
                hint={t('leadReminderHint')}
                rows={4}
                value={current.leadReminderText}
                disabled={!editable}
                onChange={value => patch('leadReminderText', value)}
              />
              <div className="ag-note ag-note-left ag-prompt-default-hint">{t('promptDefaultHint')}</div>
            </div>
            ) : (
            <div className="ag-tab-panel" role="tabpanel" id="ag-panel-rules" aria-labelledby="ag-tab-rules">
            <Section title={t('sectionBudgets')} hint={t('budgetsHint')}>
              <div className="ag-budget-table">
                <div className="ag-budget-row ag-budget-head">
                  <span className="ag-budget-prefix">{t('prefixHeader')}</span>
                  <span>{t('fieldStepBudget')}</span>
                  <span>{t('fieldReadCalls')}</span>
                  <span>{t('fieldReadFiles')}</span>
                  <span>{t('fieldWriteFiles')}</span>
                  <span>{t('fieldReminders')}</span>
                </div>
                {BUDGET_PREFIXES.map(prefix => {
                  const budget = budgetFor(prefix)
                  return (
                    <div className="ag-budget-row" key={prefix}>
                      <span className="ag-budget-prefix">{prefix}</span>
                      <BudgetNumberInput
                        value={budget.stepBudget}
                        disabled={!editable}
                        ariaLabel={`${prefix} ${t('fieldStepBudget')}`}
                        onChange={value => patchBudget(prefix, 'stepBudget', value)}
                      />
                      <BudgetNumberInput
                        value={budget.readCalls}
                        disabled={!editable}
                        ariaLabel={`${prefix} ${t('fieldReadCalls')}`}
                        onChange={value => patchBudget(prefix, 'readCalls', value)}
                      />
                      <BudgetNumberInput
                        value={budget.readFiles}
                        disabled={!editable}
                        ariaLabel={`${prefix} ${t('fieldReadFiles')}`}
                        onChange={value => patchBudget(prefix, 'readFiles', value)}
                      />
                      <BudgetNumberInput
                        value={budget.writeFiles}
                        disabled={!editable}
                        ariaLabel={`${prefix} ${t('fieldWriteFiles')}`}
                        onChange={value => patchBudget(prefix, 'writeFiles', value)}
                      />
                      <RemindersInput
                        value={budget.reminders}
                        disabled={!editable}
                        ariaLabel={`${prefix} ${t('fieldReminders')}`}
                        onChange={value => patchBudget(prefix, 'reminders', value)}
                      />
                    </div>
                  )
                })}
              </div>
            </Section>

            <Section title="Lead">
              <Field label={t('fieldLeadBudget')} hint={t('zeroUnlimited')}>
                <BudgetNumberInput
                  value={current.leadStepBudget}
                  disabled={!editable}
                  ariaLabel={t('fieldLeadBudget')}
                  onChange={value => patch('leadStepBudget', value)}
                />
              </Field>
            </Section>
            </div>
            )}
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

            <div className="ag-drawer-actions">
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
            </div>
          </>,
          document.body
        )
        : null}
    </>
  )
}

interface ChildTagProps extends SlotProps {
  t: Translate
  useLocale: () => number
}

function GuardChildTag(props: ChildTagProps): React.ReactElement | null {
  const { t, useLocale } = props
  useLocale()
  const useSession = props.useSession
  const subagent = typeof useSession === 'function'
    ? useSession(snapshot => snapshot.subagent ?? null)
    : null
  if (subagent === null) return null
  const mode = subagent.address?.mode
  return (
    <span className="ag-child-tag" data-mode={mode} title={t('subagentTagTitle')}>
      <span className="ag-child-tag-dot" aria-hidden="true" />
      {t('subagentTag')}
    </span>
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

  ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register(
    { name: 'conversation.input.overlay', id: `${NS}:child`, order: 0 },
    (props: SlotProps) => <GuardChildTag {...props} t={t} useLocale={useLocale} />
  ))
}
