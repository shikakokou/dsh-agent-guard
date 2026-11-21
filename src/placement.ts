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

export const MARGIN = 8
export const GAP = 8
export const MAX_HEIGHT = 560
export const MIN_HEIGHT = 96

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

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
  const maxHeight = Math.min(height, Math.max(room, MIN_HEIGHT), viewport.height - MARGIN * 2)
  const top = drop ? anchor.bottom + GAP : anchor.top - GAP - maxHeight
  return {
    left: clamp(anchor.left, MARGIN, viewport.width - MARGIN - card.width),
    top: clamp(top, MARGIN, viewport.height - MARGIN - maxHeight),
    maxHeight
  }
}
