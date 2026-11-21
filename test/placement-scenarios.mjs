import assert from 'node:assert/strict'
import { computePlacement, MARGIN } from '../src/placement.ts'

// Short windows matter: the top clamp is what keeps the panel inside them.
const VIEWPORT_HEIGHTS = [200, 240, 320, 480, 600, 768, 900, 1200]
const VIEWPORT_WIDTHS = [375, 768, 1024, 1440]
const CARD_WIDTHS = [260, 300]
const CARD_HEIGHTS = [120, 300, 560, 900]
const TRIGGER_HEIGHT = 36

const results = []
function check(title, fn) {
  try {
    fn()
    results.push({ title, ok: true })
  } catch (error) {
    results.push({ title, ok: false, error })
  }
}

function cases() {
  const all = []
  for (const viewportHeight of VIEWPORT_HEIGHTS) {
    const triggerTops = [
      0,
      Math.round(viewportHeight * 0.25),
      Math.round(viewportHeight * 0.5),
      Math.round(viewportHeight * 0.75),
      viewportHeight - TRIGGER_HEIGHT,
    ]
    for (const viewportWidth of VIEWPORT_WIDTHS) {
      const triggerLefts = [0, 24, Math.round(viewportWidth * 0.5), viewportWidth - 88, viewportWidth - 300]
      for (const cardWidth of CARD_WIDTHS) {
        for (const cardHeight of CARD_HEIGHTS) {
          for (const top of triggerTops) {
            for (const left of triggerLefts) {
              all.push({
                anchor: { left, top, bottom: top + TRIGGER_HEIGHT, right: left + 160 },
                card: { width: cardWidth, height: cardHeight },
                viewport: { width: viewportWidth, height: viewportHeight },
              })
            }
          }
        }
      }
    }
  }
  return all
}

const describe = ({ anchor, card, viewport }) => JSON.stringify({ anchor, card, viewport })

check('panel stays inside the viewport for every window/trigger/content combination', () => {
  const all = cases()
  for (const { anchor, card, viewport } of all) {
    const where = describe({ anchor, card, viewport })
    const placement = computePlacement(anchor, card, viewport)
    assert.ok(placement.maxHeight > 0, `maxHeight must stay positive, got ${placement.maxHeight}: ${where}`)
    assert.ok(placement.top >= MARGIN, `top ${placement.top} is above the ${MARGIN}px margin: ${where}`)
    assert.ok(
      placement.top + placement.maxHeight <= viewport.height - MARGIN,
      `panel bottom ${placement.top + placement.maxHeight} leaves no ${MARGIN}px margin: ${where}`,
    )
    assert.ok(placement.left >= MARGIN, `left ${placement.left} is left of the ${MARGIN}px margin: ${where}`)
    assert.ok(
      placement.left + card.width <= viewport.width - MARGIN,
      `panel right ${placement.left + card.width} leaves no ${MARGIN}px margin: ${where}`,
    )
  }
})

check('a short window caps the panel height instead of letting it overflow', () => {
  for (const [viewportHeight, cardHeight] of [[320, 900], [480, 900], [600, 1200]]) {
    const anchor = { left: 300, top: viewportHeight - TRIGGER_HEIGHT, bottom: viewportHeight, right: 460 }
    const viewport = { width: 1024, height: viewportHeight }
    const placement = computePlacement(anchor, { width: 300, height: cardHeight }, viewport)
    assert.ok(
      placement.maxHeight <= viewportHeight - MARGIN * 2,
      `panel can grow past the window: maxHeight ${placement.maxHeight}, window ${viewportHeight}`,
    )
    assert.ok(placement.maxHeight < cardHeight, 'natural content still needs the scroll body')
  }
})

for (const { title, ok } of results) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${title}`)
}
const failed = results.filter(result => !result.ok)
if (failed.length > 0) {
  console.error('')
  for (const result of failed) console.error(result.error)
  process.exitCode = 1
} else {
  console.log(`\n${results.length}/${results.length} passed`)
}
