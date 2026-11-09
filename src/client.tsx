/** 输入框底部的 Guard 按钮与浮窗：展示四道硬约束的当前参数。 */
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { guardRows, normalizeGuard } from './guard.ts'
import type { GuardConfig } from './guard.ts'
import styles from './styles.css?raw'
import type { ClientContext, SlotProps } from './types.ts'

const NS = 'dsh-agent-guard'
const PANEL_WIDTH = 300
const VIEWPORT_MARGIN = 8

/** `modelSelection` 投影的客户端视图。 */
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

/** 读当前会话的模型投影；宿主没给 useProjection 时返回未知。 */
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

/** 读 Host 下发的 `agentGuard` 投影；投影未就绪时用默认值。 */
function useGuardConfig(props: SlotProps): GuardConfig {
  const useProjection = props.useProjection
  const raw = typeof useProjection === 'function' ? useProjection('agentGuard') : undefined
  return normalizeGuard(raw)
}

/** 浮窗挂在按钮上方：按按钮矩形算 fixed 坐标，跟随窗口尺寸与滚动更新。 */
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

/** 输入框底部的槽位组件。 */
function GuardDock(props: SlotProps): React.ReactElement {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const placement = useAnchorPlacement(open, anchor)
  const { route, model } = useCurrentRoute(props)
  const config = useGuardConfig(props)
  const rows = guardRows(config)
  const leadDiffers = model !== undefined && model !== config.model

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

  return (
    <>
      <button
        ref={anchor}
        type="button"
        className="ag-trigger"
        data-open={open ? 'true' : 'false'}
        aria-expanded={open}
        aria-label="agent-guard 状态"
        title="agent-guard：agent 行为护栏"
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
            aria-label="agent-guard 状态"
            style={{ left: placement.left, bottom: placement.bottom, width: PANEL_WIDTH }}
          >
            <div className="ag-head">
              <span className="ag-title">agent-guard</span>
              <span className="ag-state">{config.enabled ? '生效中' : '已停用'}</span>
            </div>
            <div className="ag-sep" />
            {rows.map(row => (
              <div className="ag-row" key={row.label}>
                <span className="ag-label">{row.label}</span>
                <span className={row.mono === true ? 'ag-value mono' : 'ag-value'}>{row.value}</span>
              </div>
            ))}
            <div className="ag-row">
              <span className="ag-label">当前 Lead</span>
              <span className="ag-value">{route}</span>
            </div>
            {leadDiffers
              ? <div className="ag-diff">Lead 当前不是 {config.model}，子智能体仍会按上面的参数启动。</div>
              : null}
            <div className="ag-hint">
              四道硬约束在 Host 执行，本浮窗读的是 Host 下发的生效配置（`agentGuard` 投影）。改配置见 profile 的 cordis.patch.yml 中 agent-guard 条目，改完重启 dsh web。
            </div>
          </div>,
          document.body
        )
        : null}
    </>
  )
}

export const inject = ['slots']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.plugin = NS
    style.textContent = styles
    document.head.append(style)
    return () => style.remove()
  }, 'dsh-agent-guard: styles')

  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register(
    { name: 'conversation.composer.dock', id: NS, order: 60 },
    GuardDock
  ))
}
