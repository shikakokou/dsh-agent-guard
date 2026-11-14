export interface AnchorRect {
  left: number
  top: number
  bottom: number
  right: number
}

export interface CardSize {
  width: number
  height: number
}

export interface ViewportSize {
  width: number
  height: number
}

export interface Placement {
  left: number
  top: number
  maxHeight: number
}

/** Gap the panel keeps from the window edge. */
export const MARGIN = 8
/** Gap the panel keeps from the trigger. */
export const GAP = 8
/** The panel never grows taller than this, even in a tall window. */
export const MAX_HEIGHT = 560
/** Below this the panel would be useless, so it wins over a cramped window. */
export const MIN_HEIGHT = 96

/** Clamp `value` into [min, max]; a window smaller than the panel wins ties. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

/**
 * Where the fixed-positioned panel goes for a trigger at `anchor`, so that it
 * stays inside the viewport on every side. The panel keeps its left edge on the
 * trigger's left edge, opens upward by default, and falls back to the roomier
 * side with an internal scroll when it does not fit.
 */
export function computePlacement(
  anchor: AnchorRect,
  card: CardSize,
  viewport: ViewportSize
): Placement {
  const height = Math.min(card.height, MAX_HEIGHT, viewport.height - MARGIN * 2)
  const above = anchor.top - GAP - MARGIN
  const below = viewport.height - anchor.bottom - GAP - MARGIN
  const drop = height > above && (height <= below || below > above)
  const room = drop ? below : above
  // A window shorter than MIN_HEIGHT + margins cannot fit the panel at all;
  // capping here keeps the panel inside the window instead of pushing it out.
  const maxHeight = Math.min(height, Math.max(room, MIN_HEIGHT), viewport.height - MARGIN * 2)
  const top = drop ? anchor.bottom + GAP : anchor.top - GAP - maxHeight
  return {
    left: clamp(anchor.left, MARGIN, viewport.width - MARGIN - card.width),
    top: clamp(top, MARGIN, viewport.height - MARGIN - maxHeight),
    maxHeight
  }
}
