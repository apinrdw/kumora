import { UNCLASSIFIED, type SectorName, type StockCode } from "@workspace/relay"
import { cn } from "@workspace/ui/lib/utils"
import { Effect } from "effect"
import { useEffect, useRef, useState } from "react"

import {
  packSectors,
  sectorGroups,
  type SectorLookup,
} from "@/lib/bubble-sectors"
import {
  bubbleScale,
  bubbleTone,
  LABEL_RADII,
  sizeFigure,
  type BubbleFigures,
  type BubbleView,
} from "@/lib/bubbles"
import { compact, lots, pct, price } from "@/lib/format"

// The figures a bubble writes, made once a recompute, not each frame.
interface Labels {
  readonly metric: string
  readonly size: string
}

// One bubble on the canvas: where it is and moves, its radius and tone now
// and the targets they ease to, and the figures it shows.
interface Body {
  readonly code: StockCode
  sector: SectorName
  x: number
  y: number
  vx: number
  vy: number
  r: number
  targetR: number
  tone: number
  targetTone: number
  // The radius drawn: r, or the hover's 1.7×, eased.
  shownR: number
  figures: BubbleFigures
  labels: Labels
  leaving: boolean
}

// What a pointer is over, for the tooltip.
interface Hovered {
  readonly figures: BubbleFigures
  readonly x: number
  readonly y: number
  // The canvas's size, to keep the tooltip inside it.
  readonly width: number
  readonly height: number
}

// A sector's cluster centre, easing toward where the last pack put it.
interface Anchor {
  x: number
  y: number
  tx: number
  ty: number
}

// A sector's label above its cluster: its name, then its total and its
// delta or change %, toned by that %'s sign.
interface SectorLabel {
  readonly name: string
  readonly figures: string
  readonly sign: number
}

// Where a sector label was last drawn, for a click.
interface LabelBox {
  readonly sector: SectorName
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
}

// What the canvas keeps between frames and renders: its bodies, the bubble
// a pointer is over and where a press began, and each sector's anchor,
// label and where that label was last drawn.
interface Scene {
  readonly bodies: Map<StockCode, Body>
  hovered: StockCode | undefined
  pressedAt: { readonly x: number; readonly y: number } | undefined
  readonly anchors: Map<SectorName, Anchor>
  labels: ReadonlyMap<SectorName, SectorLabel>
  boxes: ReadonlyArray<LabelBox>
}

type Rgb = readonly [number, number, number]

interface Palette {
  readonly up: Rgb
  readonly down: Rgb
  readonly neutral: Rgb
  readonly core: Rgb
  readonly ring: string
  readonly label: string
  readonly labelSecondary: string
  readonly labelMuted: string
  readonly font: string
}

// Motion (spec apinrdw/kumora#427, "Cadence"): radius and tone ease 12 % and
// 10 % of the way to their targets each frame.
const RADIUS_EASE = 0.12
const TONE_EASE = 0.1
const HOVER_EASE = 0.25
const HOVER_SCALE = 1.7
const HOVER_MIN_RADIUS = 34
// Only this many of the largest bubbles get a blurred glow.
const GLOWING = 120
// A press that moves no further than this is a click.
const CLICK_SLOP = 4
const GAP = 1.5
// Cluster centres ease 2 % of the way to their targets each frame, and pull
// their bubbles in.
const ANCHOR_EASE = 0.02
const ANCHOR_PULL = 0.012
const DAMPING = 0.75

// The long sector names, shortened above a cluster.
const SHORT_SECTOR: Partial<Record<SectorName, string>> = {
  "Consumer Non-Cyclicals": "Non-Cyclicals",
  "Consumer Cyclicals": "Cyclicals",
  "Properties & Real Estate": "Property",
  "Transportation & Logistic": "Transport",
}

const NO_NAMES: ReadonlyMap<StockCode, string> = new Map()
const NO_SECTORS: SectorLookup = new Map()

// Every bubble of `bubbles` on one canvas, sized by `view`'s size metric and
// toned by its colour metric, easing between the figures each recompute
// brings, one cluster per sector of `sectors`, each labelled. A code that
// leaves shrinks out and one that joins grows in. Hovering a bubble grows it
// and shows its figures; a click hands its code to `onPick`, and a click on
// a sector label hands its sector to `onPickSector`. The page and Market
// Live's panel both draw with it.
export function BubbleCanvas({
  bubbles,
  view,
  names = NO_NAMES,
  sectors = NO_SECTORS,
  onPick,
  onPickSector,
  className,
}: {
  bubbles: ReadonlyArray<BubbleFigures>
  view: BubbleView
  names?: ReadonlyMap<StockCode, string>
  sectors?: SectorLookup
  onPick: (code: StockCode) => void
  onPickSector?: (sector: SectorName) => void
  className?: string
}) {
  const host = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const scene = useRef<Scene>({
    bodies: new Map(),
    hovered: undefined,
    pressedAt: undefined,
    anchors: new Map(),
    labels: new Map(),
    boxes: [],
  })
  const picks = useRef({ onPick, onPickSector })
  const [hovered, setHovered] = useState<Hovered | undefined>(undefined)

  useEffect(() => {
    picks.current = { onPick, onPickSector }
  }, [onPick, onPickSector])

  // Each recompute: new targets, joining bubbles in, leaving ones out.
  useEffect(() => {
    const element = host.current
    if (element === null) return
    const width = element.clientWidth
    const height = element.clientHeight
    const { k, minRadius } = Effect.runSync(
      bubbleScale(
        bubbles.map((bubble) => bubble.size),
        width * height
      )
    )
    const held = scene.current.bodies
    const shown = new Set<StockCode>()
    for (const figures of bubbles) {
      shown.add(figures.code)
      const sector = sectors.get(figures.code) ?? UNCLASSIFIED
      Effect.runSync(
        retarget(held, figures, {
          sector,
          view,
          targetR: Math.max(minRadius, k * Math.sqrt(figures.size)),
          near: scene.current.anchors.get(sector) ?? {
            x: width / 2,
            y: height / 2,
          },
        })
      )
    }
    for (const [code, body] of held) if (!shown.has(code)) body.leaving = true
    Effect.runSync(placeSectors(scene.current.anchors, held, width, height))
    scene.current.labels = Effect.runSync(labelsOf(bubbles, sectors, view))
    // The tooltip follows its bubble's new figures.
    setHovered((last) => {
      const code = scene.current.hovered
      const body = code === undefined ? undefined : held.get(code)
      if (last === undefined || body === undefined || body.leaving)
        return undefined
      return { ...last, figures: body.figures }
    })
  }, [bubbles, view, sectors])

  // The frame loop: motion, then drawing.
  useEffect(() => {
    const element = host.current
    const surface = canvas.current
    const context = surface?.getContext("2d")
    if (element === null || surface === null || !context) return
    const css = getComputedStyle(document.documentElement)
    const token = (name: string) => css.getPropertyValue(name).trim()
    const rgb = (name: string): Rgb => {
      const hex = token(name).replace("#", "")
      return [0, 2, 4].map((at) =>
        Number.parseInt(hex.slice(at, at + 2), 16)
      ) as unknown as Rgb
    }
    const palette: Palette = {
      up: rgb("--bubble-up"),
      down: rgb("--bubble-down"),
      neutral: rgb("--bubble-neutral"),
      core: rgb("--bubble-core"),
      ring: token("--bubble-ring"),
      label: token("--bubble-label"),
      labelSecondary: token("--bubble-label-secondary"),
      labelMuted: token("--bubble-label-muted"),
      font: getComputedStyle(element).fontFamily,
    }
    let width = 0
    let height = 0
    let ratio = 1
    const resize = () => {
      ratio = Math.min(2, window.devicePixelRatio || 1)
      width = element.clientWidth
      height = element.clientHeight
      surface.width = Math.round(width * ratio)
      surface.height = Math.round(height * ratio)
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(element)

    // The tone's colour: neutral toward up or down, by |t|^0.6.
    const mix = (tone: number): Rgb => {
      const strength = Math.abs(tone) ** 0.6
      const to = tone >= 0 ? palette.up : palette.down
      return [0, 1, 2].map((i) =>
        Math.round(
          palette.neutral[i]! + (to[i]! - palette.neutral[i]!) * strength
        )
      ) as unknown as Rgb
    }

    // One body's frame: its radius, tone and hover ease, and the pull toward
    // its sector's centre.
    const move = (body: Body) => {
      body.r += ((body.leaving ? 0 : body.targetR) - body.r) * RADIUS_EASE
      body.tone += (body.targetTone - body.tone) * TONE_EASE
      const shown =
        body.code === scene.current.hovered
          ? Math.max(body.r * HOVER_SCALE, HOVER_MIN_RADIUS)
          : body.r
      body.shownR += (shown - body.shownR) * HOVER_EASE
      const anchor = scene.current.anchors.get(body.sector)
      body.vx += ((anchor?.x ?? width / 2) - body.x) * ANCHOR_PULL
      body.vy += ((anchor?.y ?? height / 2) - body.y) * ANCHOR_PULL
      body.vx *= DAMPING
      body.vy *= DAMPING
      body.x += body.vx
      body.y += body.vy
    }

    // Pushes two overlapping bodies apart, the smaller further.
    const separate = (a: Body, b: Body) => {
      const dx = b.x - a.x
      const dy = b.y - a.y
      const touching = a.r + GAP + b.r
      const squared = dx * dx + dy * dy
      if (squared >= touching * touching || squared === 0) return
      const distance = Math.sqrt(squared)
      const push = ((touching - distance) / distance) * 0.5
      const weightA = (b.r * b.r) / (a.r * a.r + b.r * b.r + 1e-6)
      a.x -= dx * push * weightA
      a.y -= dy * push * weightA
      b.x += dx * push * (1 - weightA)
      b.y += dy * push * (1 - weightA)
    }

    // Collisions, by sweep and prune on x.
    const collide = (list: Array<Body>) => {
      list.sort((a, b) => a.x - a.r - (b.x - b.r))
      for (let i = 0; i < list.length; i++) {
        const a = list[i]!
        for (let j = i + 1; j < list.length; j++) {
          const b = list[j]!
          if (b.x - b.r > a.x + a.r + GAP) break
          separate(a, b)
        }
      }
    }

    const step = (list: Array<Body>) => {
      for (const anchor of scene.current.anchors.values()) {
        anchor.x += (anchor.tx - anchor.x) * ANCHOR_EASE
        anchor.y += (anchor.ty - anchor.y) * ANCHOR_EASE
      }
      for (const body of list) move(body)
      collide(list)
      collide(list)
      for (const body of list) {
        body.x = Math.min(Math.max(body.x, body.r), width - body.r)
        body.y = Math.min(Math.max(body.y, body.r), height - body.r)
        if (body.leaving && body.r < 0.5) scene.current.bodies.delete(body.code)
      }
    }

    const label = (body: Body, radius: number) => {
      if (radius < LABEL_RADII.code) return
      const lines =
        radius >= LABEL_RADII.figure ? 3 : radius >= LABEL_RADII.metric ? 2 : 1
      const size = Math.max(8, Math.min(30, radius * 0.36))
      const lineHeight = size * 0.95
      const top = body.y - (lines - 1) * lineHeight * 0.5
      context.textAlign = "center"
      context.textBaseline = "middle"
      context.fillStyle = palette.label
      context.font = `800 ${size}px ${palette.font}`
      context.fillText(body.code, body.x, top)
      if (lines >= 2) {
        context.font = `700 ${size * 0.58}px ${palette.font}`
        context.fillStyle = palette.labelSecondary
        context.fillText(body.labels.metric, body.x, top + lineHeight * 0.9)
      }
      if (lines >= 3) {
        context.font = `600 ${size * 0.5}px ${palette.font}`
        context.fillStyle = palette.labelMuted
        context.fillText(body.labels.size, body.x, top + lineHeight * 1.65)
      }
    }

    const disc = (body: Body, radius: number, glow: boolean) => {
      const [red, green, blue] = mix(body.tone)
      const strength = 0.35 + 0.65 * Math.abs(body.tone) ** 0.6
      const [coreRed, coreGreen, coreBlue] = palette.core
      const fill = context.createRadialGradient(
        body.x,
        body.y,
        radius * 0.2,
        body.x,
        body.y,
        radius
      )
      fill.addColorStop(0, `rgba(${coreRed},${coreGreen},${coreBlue},0.95)`)
      fill.addColorStop(
        0.75,
        `rgba(${red},${green},${blue},${0.08 * strength})`
      )
      fill.addColorStop(1, `rgba(${red},${green},${blue},${0.32 * strength})`)
      context.beginPath()
      context.arc(body.x, body.y, radius, 0, Math.PI * 2)
      context.fillStyle = fill
      context.fill()
      if (glow) {
        context.shadowBlur = Math.min(22, radius * 0.3)
        context.shadowColor = `rgba(${red},${green},${blue},${0.9 * strength})`
      }
      context.lineWidth = radius > 40 ? 3 : radius > 16 ? 2 : 1.2
      context.strokeStyle = `rgba(${red},${green},${blue},${0.55 + 0.45 * strength})`
      context.stroke()
      context.shadowBlur = 0
    }

    // Each sector's cluster: the mean x of its staying bubbles and their top.
    const clusterTops = (list: ReadonlyArray<Body>) => {
      const tops = new Map<
        SectorName,
        { sum: number; n: number; top: number }
      >()
      for (const body of list) {
        if (body.leaving || body.r < 0.6) continue
        const held = tops.get(body.sector) ?? { sum: 0, n: 0, top: Infinity }
        held.sum += body.x
        held.n += 1
        held.top = Math.min(held.top, body.y - body.r)
        tops.set(body.sector, held)
      }
      return [...tops].map(
        ([sector, { sum, n, top }]) => [sector, { x: sum / n, top }] as const
      )
    }

    // Each sector's label, centred above its bubbles.
    const drawSectorLabels = (list: ReadonlyArray<Body>) => {
      const boxes: Array<LabelBox> = []
      for (const [sector, { x, top }] of clusterTops(list)) {
        const heading = scene.current.labels.get(sector)
        if (heading === undefined) continue
        const bottom = Math.max(30, top - 4)
        context.textAlign = "center"
        context.textBaseline = "bottom"
        context.font = `700 12px ${palette.font}`
        context.fillStyle = palette.labelSecondary
        context.fillText(heading.name, x, bottom - 13)
        const nameWidth = context.measureText(heading.name).width
        context.font = `600 11px ${palette.font}`
        const [red, green, blue] =
          heading.sign > 0
            ? palette.up
            : heading.sign < 0
              ? palette.down
              : palette.neutral
        context.fillStyle = `rgb(${red},${green},${blue})`
        context.fillText(heading.figures, x, bottom)
        const half =
          Math.max(nameWidth, context.measureText(heading.figures).width) / 2
        boxes.push({
          sector,
          left: x - half,
          right: x + half,
          top: bottom - 28,
          bottom,
        })
      }
      return boxes
    }

    let frame = 0
    let tick = 0
    const draw = () => {
      const list = [...scene.current.bodies.values()]
      step(list)
      context.setTransform(ratio, 0, 0, ratio, 0, 0)
      context.clearRect(0, 0, width, height)
      list.sort((a, b) => a.r - b.r)
      const glowFrom =
        list.length > GLOWING ? list[list.length - GLOWING]!.r : 0
      let top: Body | undefined
      for (const body of list) {
        if (body.code === scene.current.hovered) {
          top = body
          continue
        }
        if (body.r < 0.6) continue
        disc(body, body.r, body.r >= glowFrom && body.r > 14)
        label(body, body.r)
      }
      scene.current.boxes = drawSectorLabels(list)
      // The hovered bubble, grown and ringed, over its neighbours.
      if (top !== undefined) {
        // Opaque, so the neighbours it covers don't show through.
        const [coreRed, coreGreen, coreBlue] = palette.core
        context.beginPath()
        context.arc(top.x, top.y, top.shownR, 0, Math.PI * 2)
        context.fillStyle = `rgb(${coreRed},${coreGreen},${coreBlue})`
        context.fill()
        disc(top, top.shownR, true)
        context.beginPath()
        context.arc(top.x, top.y, top.shownR, 0, Math.PI * 2)
        context.lineWidth = 2.5
        context.strokeStyle = palette.ring
        context.stroke()
        label(top, top.shownR)
      }
      // What the e2e reads: the count, and the largest bubble's centre.
      if (tick++ % 10 === 0) {
        const staying = list.filter((body) => !body.leaving)
        const largest = staying.at(-1)
        surface.dataset.bubbles = String(staying.length)
        if (largest === undefined) {
          delete surface.dataset.largest
          delete surface.dataset.largestAt
        } else {
          surface.dataset.largest = largest.code
          surface.dataset.largestAt = `${Math.round(largest.x)},${Math.round(largest.y)}`
        }
        surface.dataset.sectorLabels = JSON.stringify(
          Object.fromEntries(
            scene.current.boxes.map((box) => [
              box.sector,
              `${Math.round((box.left + box.right) / 2)},${Math.round((box.top + box.bottom) / 2)}`,
            ])
          )
        )
      }
      frame = requestAnimationFrame(draw)
    }
    frame = requestAnimationFrame(draw)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [])

  // The bubble under a point, the smallest when they overlap.
  const hit = (x: number, y: number) => {
    let found: Body | undefined
    for (const body of scene.current.bodies.values()) {
      if (body.leaving) continue
      const reach = body.code === scene.current.hovered ? body.shownR : body.r
      if (Math.hypot(body.x - x, body.y - y) > reach) continue
      if (found === undefined || body.r < found.r) found = body
    }
    return found
  }
  // The sector label under a point, when a click on one picks it.
  const labelAt = (x: number, y: number) =>
    picks.current.onPickSector &&
    Effect.runSync(labelUnder(scene.current.boxes, x, y))
  // A press let go within CLICK_SLOP of where it began: a click on the label
  // or the bubble under it.
  const release = (event: React.PointerEvent) => {
    const from = scene.current.pressedAt
    scene.current.pressedAt = undefined
    const at = pointAt(event)
    if (
      from === undefined ||
      Math.hypot(at.x - from.x, at.y - from.y) > CLICK_SLOP
    )
      return
    const sector = labelAt(at.x, at.y)
    if (sector !== undefined) return picks.current.onPickSector?.(sector)
    const body = hit(at.x, at.y)
    if (body !== undefined) picks.current.onPick(body.code)
  }
  const pointAt = (event: React.PointerEvent) => {
    const box = canvas.current!.getBoundingClientRect()
    return {
      x: event.clientX - box.left,
      y: event.clientY - box.top,
      width: box.width,
      height: box.height,
    }
  }

  return (
    <div ref={host} className={cn("relative overflow-hidden", className)}>
      <canvas
        ref={canvas}
        role="img"
        aria-label={`Market Bubbles: ${bubbles.length} stock codes`}
        className="absolute inset-0 size-full"
        onPointerMove={(event) => {
          const at = pointAt(event)
          const body = hit(at.x, at.y)
          event.currentTarget.style.cursor =
            body !== undefined || labelAt(at.x, at.y) !== undefined
              ? "pointer"
              : "default"
          scene.current.hovered = body?.code
          setHovered(body && { figures: body.figures, ...at })
        }}
        onPointerLeave={() => {
          scene.current.hovered = undefined
          setHovered(undefined)
        }}
        onPointerDown={(event) => {
          scene.current.pressedAt = pointAt(event)
        }}
        onPointerUp={release}
      />
      {hovered && (
        <BubbleTip
          hovered={hovered}
          view={view}
          name={names.get(hovered.figures.code)}
          sectors={sectors}
        />
      )}
    </div>
  )
}

// A recompute's figures for one bubble: its new targets, or a new body that
// grows in near its sector's centre, where its neighbours make room.
const retarget = Effect.fnUntraced(function* (
  held: Map<StockCode, Body>,
  figures: BubbleFigures,
  {
    sector,
    view,
    targetR,
    near,
  }: {
    readonly sector: SectorName
    readonly view: BubbleView
    readonly targetR: number
    readonly near: { readonly x: number; readonly y: number }
  }
) {
  const metric = view.colour === "delta" ? figures.delta : figures.change
  const labels: Labels = {
    metric: metric === undefined ? "—" : yield* pct(metric),
    size: yield* sizeFigure(view.size, figures.size),
  }
  const targetTone = (yield* bubbleTone(figures, view)) ?? 0
  const body = held.get(figures.code)
  if (body === undefined) {
    const angle = Math.random() * Math.PI * 2
    held.set(figures.code, {
      code: figures.code,
      sector,
      x: near.x + Math.cos(angle) * 12,
      y: near.y + Math.sin(angle) * 12,
      vx: 0,
      vy: 0,
      r: 0,
      shownR: 0,
      targetR,
      tone: targetTone,
      targetTone,
      figures,
      labels,
      leaving: false,
    })
    return
  }
  body.sector = sector
  body.targetR = targetR
  body.targetTone = targetTone
  body.figures = figures
  body.labels = labels
  body.leaving = false
})

// The sector label under a point, if any.
const labelUnder = (boxes: ReadonlyArray<LabelBox>, x: number, y: number) =>
  Effect.sync(
    () =>
      boxes.find(
        (box) =>
          x >= box.left && x <= box.right && y >= box.top && y <= box.bottom
      )?.sector
  )

// Packs the sectors of the staying bodies by their target areas, from the
// targets the last pack left, and sets each anchor's new target. A new
// sector's anchor starts at its target.
const placeSectors = Effect.fnUntraced(function* (
  anchors: Map<SectorName, Anchor>,
  bodies: ReadonlyMap<StockCode, Body>,
  width: number,
  height: number
) {
  const areas = new Map<SectorName, number>()
  for (const body of bodies.values())
    if (!body.leaving)
      areas.set(
        body.sector,
        (areas.get(body.sector) ?? 0) + Math.PI * body.targetR ** 2
      )
  const previous = new Map(
    [...anchors].map(([sector, { tx, ty }]) => [sector, { x: tx, y: ty }])
  )
  const circles = yield* packSectors(
    [...areas].map(([sector, area]) => ({ sector, area })),
    width,
    height,
    previous
  )
  for (const { sector, x, y } of circles) {
    const anchor = anchors.get(sector)
    if (anchor === undefined) anchors.set(sector, { x, y, tx: x, ty: y })
    else {
      anchor.tx = x
      anchor.ty = y
    }
  }
})

// Each sector's label: its name, then its total of the size metric and its
// delta % or change %.
const labelsOf = Effect.fnUntraced(function* (
  bubbles: ReadonlyArray<BubbleFigures>,
  sectors: SectorLookup,
  view: BubbleView
) {
  const labels = new Map<SectorName, SectorLabel>()
  for (const group of yield* sectorGroups(bubbles, sectors)) {
    const metric = view.colour === "delta" ? group.delta : group.change
    labels.set(group.sector, {
      name: SHORT_SECTOR[group.sector] ?? group.sector,
      figures: `${yield* sizeFigure(view.size, group.total)} · ${
        metric === undefined ? "—" : yield* pct(metric)
      }`,
      sign: metric ?? 0,
    })
  }
  return labels
})

const TONE_CLASS = (n: number | undefined) =>
  n === undefined || n === 0 ? "" : n > 0 ? "text-up" : "text-down"

// The hovered bubble's figures: its code and day change, its company and
// sector, its price, then the window's value, volume, frequency, Buy/Sell delta and
// change.
function BubbleTip({
  hovered,
  view,
  name,
  sectors,
}: {
  hovered: Hovered
  view: BubbleView
  name: string | undefined
  sectors: SectorLookup
}) {
  const { figures } = hovered
  const sector = sectors.get(figures.code) ?? UNCLASSIFIED
  const percent = (n: number | undefined) =>
    n === undefined ? "—" : Effect.runSync(pct(n))
  const rows: ReadonlyArray<readonly [string, string, string?]> = [
    ["Price", Effect.runSync(price(figures.last))],
    [
      `Value (${view.window})`,
      Effect.runSync(sizeFigure("value", figures.value)),
    ],
    ["Volume", `${Effect.runSync(lots(Math.round(figures.volume)))} lots`],
    ["Frequency", Effect.runSync(compact(figures.frequency))],
    ["Buy/Sell delta", percent(figures.delta), TONE_CLASS(figures.delta)],
    [
      `Change (${view.window})`,
      percent(figures.change),
      TONE_CLASS(figures.change),
    ],
  ]
  const width = 200
  const left = Math.min(hovered.x + 14, hovered.width - width - 4)
  const top = Math.min(hovered.y + 14, hovered.height - 190)
  return (
    <div
      role="tooltip"
      aria-label={`${figures.code} figures`}
      className="border-strong pointer-events-none absolute z-10 rounded-md border bg-popover px-2.5 py-2 text-xs shadow-popover"
      style={{ left: Math.max(4, left), top: Math.max(4, top), width }}
    >
      <div className="flex items-baseline justify-between gap-2 text-[13px] font-extrabold">
        <span>{figures.code}</span>
        <span className={cn("num", TONE_CLASS(figures.dayChange))}>
          {percent(figures.dayChange)}
        </span>
      </div>
      <div className="mb-1 truncate text-muted-foreground">
        {name === undefined || name === "" ? sector : `${name} · ${sector}`}
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3">
        {rows.map(([term, value, tone]) => (
          <div key={term} className="contents">
            <dt className="text-muted-foreground">{term}</dt>
            <dd className={cn("num text-right", tone)}>{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}
