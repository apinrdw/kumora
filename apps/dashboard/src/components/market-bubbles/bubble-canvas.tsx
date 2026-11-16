import type { SectorName, StockCode } from "@workspace/relay"
import { cn } from "@workspace/ui/lib/utils"
import { Effect } from "effect"
import { useEffect, useRef, useState } from "react"

import {
  packSectors,
  sectorGroups,
  sectorOf,
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
import {
  RETURN_DAMPING,
  RETURN_MAX_SPEED,
  RETURN_PULL,
} from "@/lib/bubble-drag"
import { compact, lots, pct, price, toneClass } from "@/lib/format"

import {
  draggedOf,
  followPointer,
  NO_POINTER,
  type Hovered,
  type Pointer,
  type PointerView,
} from "./bubble-pointer"

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
  // Frames left of its soft return home after a drag; 0 when not returning.
  returning: number
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
// a pointer is over and the press on one (Pointer), and each sector's
// anchor, label and where that label was last drawn, and the logos.
interface Scene extends Pointer {
  readonly bodies: Map<StockCode, Body>
  readonly anchors: Map<SectorName, Anchor>
  labels: ReadonlyMap<SectorName, SectorLabel>
  boxes: ReadonlyArray<LabelBox>
  // Each code's logo once asked for: loading or loaded, or null once it
  // failed (no logo for the code), so it is asked for once a page.
  readonly logos: Map<StockCode, HTMLImageElement | null>
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
const GAP = 1.5
// What a search leaves of a code that doesn't match it.
const DIMMED = 0.18
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

// A logo's width, as a share of its bubble's radius up to a cap, and the
// gap below it, as a share of its width.
const LOGO_SHARE = 0.55
const LOGO_MAX = 64
const LOGO_GAP = 0.12

// A code's logo, served by the dashboard itself (src/routes/logos/$code.ts).
// Decision: same origin, so drawing it never taints the canvas and the
// snapshot still exports. See apinrdw/kumora#432.
const logoPath = (code: StockCode) => `/logos/${encodeURIComponent(code)}`

// Every bubble of `bubbles` on one canvas, sized by `view`'s size metric and
// toned by its colour metric, easing between the figures each recompute
// brings, one cluster per sector of `sectors`, each labelled. A code that
// leaves shrinks out and one that joins grows in. Hovering a bubble grows it
// and shows its figures; dragging one shoves its neighbours aside; a click
// hands its code to `onPick`, and a click on a sector label hands its sector
// to `onPickSector`. A `search` rings the codes that contain it and dims the
// rest, without moving any; `ringed` rings its code alone, dimming none. The page and Market Live's panel both draw with
// it.
export function BubbleCanvas({
  bubbles,
  view,
  names = NO_NAMES,
  sectors = NO_SECTORS,
  search = "",
  ringed,
  onPick,
  onPickSector,
  className,
}: {
  bubbles: ReadonlyArray<BubbleFigures>
  view: BubbleView
  names?: ReadonlyMap<StockCode, string>
  sectors?: SectorLookup
  search?: string
  ringed?: StockCode
  onPick: (code: StockCode) => void
  onPickSector?: (sector: SectorName) => void
  className?: string
}) {
  const host = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const scene = useRef<Scene>({
    bodies: new Map(),
    hovered: undefined,
    press: undefined,
    anchors: new Map(),
    labels: new Map(),
    boxes: [],
    logos: new Map(),
  })
  // The latest props the frame loop reads: who a click goes to, and the
  // search, as a code would contain it.
  const latest = useRef({ onPick, onPickSector, query: "", ringed })
  const [pointerView, showPointer] = useState<PointerView>(NO_POINTER)

  useEffect(() => {
    latest.current = {
      onPick,
      onPickSector,
      query: search.trim().toUpperCase(),
      ringed,
    }
  }, [onPick, onPickSector, search, ringed])

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
      const sector = sectorOf(sectors, figures.code)
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
    showPointer((last) => {
      const code = scene.current.hovered
      const body = code === undefined ? undefined : held.get(code)
      if (last.tip === undefined || body === undefined || body.leaving)
        return last.tip === undefined ? last : NO_POINTER
      return { ...last, tip: { ...last.tip, figures: body.figures } }
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

    // One body's radius, tone and hover ease.
    const ease = (body: Body) => {
      body.r += ((body.leaving ? 0 : body.targetR) - body.r) * RADIUS_EASE
      body.tone += (body.targetTone - body.tone) * TONE_EASE
      const shown =
        body.code === scene.current.hovered
          ? Math.max(body.r * HOVER_SCALE, HOVER_MIN_RADIUS)
          : body.r
      body.shownR += (shown - body.shownR) * HOVER_EASE
    }

    const dragging = () => Effect.runSync(draggedOf(scene.current))

    // A released bubble's way home: a soft, damped pull, capped in speed, so
    // it never swings round its cluster.
    const returnHome = (body: Body, pullX: number, pullY: number) => {
      body.returning--
      body.vx = (body.vx + pullX * RETURN_PULL) * RETURN_DAMPING
      body.vy = (body.vy + pullY * RETURN_PULL) * RETURN_DAMPING
      const speed = Math.hypot(body.vx, body.vy)
      if (speed <= RETURN_MAX_SPEED) return
      body.vx *= RETURN_MAX_SPEED / speed
      body.vy *= RETURN_MAX_SPEED / speed
    }

    // One body's frame: its eases, then the pull toward its sector's centre,
    // or the pointer while it is dragged.
    const move = (body: Body) => {
      ease(body)
      const held = dragging()
      if (held?.code === body.code) {
        body.x = held.x
        body.y = held.y
        body.vx = 0
        body.vy = 0
        return
      }
      const anchor = scene.current.anchors.get(body.sector)
      const pullX = (anchor?.x ?? width / 2) - body.x
      const pullY = (anchor?.y ?? height / 2) - body.y
      if (body.returning > 0) returnHome(body, pullX, pullY)
      else {
        body.vx = (body.vx + pullX * ANCHOR_PULL) * DAMPING
        body.vy = (body.vy + pullY * ANCHOR_PULL) * DAMPING
      }
      body.x += body.vx
      body.y += body.vy
    }

    // How much of an overlap `a` takes: the smaller body moves further, and
    // the dragged one never yields.
    const yieldOf = (a: Body, b: Body, held: StockCode | undefined) => {
      if (a.code === held) return 0
      if (b.code === held) return 1
      return (b.r * b.r) / (a.r * a.r + b.r * b.r + 1e-6)
    }

    // Pushes two overlapping bodies apart, half the overlap a pass; a
    // dragged body's neighbours take all of it at once.
    const separate = (a: Body, b: Body) => {
      const dx = b.x - a.x
      const dy = b.y - a.y
      const touching = a.r + GAP + b.r
      const squared = dx * dx + dy * dy
      if (squared >= touching * touching || squared === 0) return
      const distance = Math.sqrt(squared)
      const held = dragging()?.code
      const share = a.code === held || b.code === held ? 1 : 0.5
      const push = ((touching - distance) / distance) * share
      const weightA = yieldOf(a, b, held)
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

    // The code's logo, once it has loaded; the first ask starts the load.
    const logoOf = (code: StockCode) => {
      const held = scene.current.logos
      if (!held.has(code)) {
        const image = new Image()
        image.addEventListener("error", () => held.set(code, null))
        image.src = logoPath(code)
        held.set(code, image)
      }
      const image = held.get(code)
      return image?.complete === true && image.naturalWidth > 0
        ? image
        : undefined
    }

    // How wide a bubble draws its logo, or 0 without one.
    const logoWidth = (body: Body, radius: number) =>
      radius >= LABEL_RADII.logo && logoOf(body.code) !== undefined
        ? Math.min(radius * LOGO_SHARE, LOGO_MAX)
        : 0

    const label = (body: Body, radius: number) => {
      if (radius < LABEL_RADII.code) return
      const lines =
        radius >= LABEL_RADII.figure ? 3 : radius >= LABEL_RADII.metric ? 2 : 1
      const size = Math.max(8, Math.min(30, radius * 0.36))
      const lineHeight = size * 0.95
      // The logo sits above the code, and the whole block stays centred.
      const across = logoWidth(body, radius)
      const room = across * (1 + LOGO_GAP)
      const top = body.y - (lines - 1) * lineHeight * 0.5 + room / 2
      if (across > 0)
        context.drawImage(
          logoOf(body.code)!,
          body.x - across / 2,
          top - lineHeight * 0.5 - room,
          across,
          across
        )
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

    // A white ring round a bubble: the hovered one's, or a search match's.
    const ring = (x: number, y: number, radius: number, thickness: number) => {
      context.beginPath()
      context.arc(x, y, radius, 0, Math.PI * 2)
      context.lineWidth = thickness
      context.strokeStyle = palette.ring
      context.stroke()
    }

    // A bubble as the search leaves it: ringed when its code contains the
    // search, dimmed and unlit when it doesn't, as it is with no search.
    const searched = (body: Body, glow: boolean) => {
      const searching = latest.current.query !== ""
      const match = searching && body.code.includes(latest.current.query)
      context.globalAlpha = searching && !match ? DIMMED : 1
      disc(body, body.r, glow && (!searching || match))
      if (match || body.code === latest.current.ringed)
        ring(body.x, body.y, body.r, body.r > 16 ? 3 : 2)
      label(body, body.r)
    }

    // The hovered bubble, grown, ringed and over its neighbours, kept inside
    // the canvas; the layout under it doesn't move.
    const lifted = (body: Body) => {
      const radius = body.shownR
      const x = Math.min(Math.max(body.x, radius), width - radius)
      const y = Math.min(Math.max(body.y, radius), height - radius)
      const shown = { ...body, x, y }
      // Opaque, so the neighbours it covers don't show through.
      const [coreRed, coreGreen, coreBlue] = palette.core
      context.beginPath()
      context.arc(x, y, radius, 0, Math.PI * 2)
      context.fillStyle = `rgb(${coreRed},${coreGreen},${coreBlue})`
      context.fill()
      disc(shown, radius, true)
      ring(x, y, radius, 2.5)
      label(shown, radius)
    }

    // What the e2e reads: the count, the largest bubble's code and centre,
    // the search's match count and its largest match's centre, and the
    // ringed code while it is shown.
    const centre = (body: Body | undefined) =>
      body && `${Math.round(body.x)},${Math.round(body.y)}`
    const mark = (name: string, value: string | undefined) => {
      if (value === undefined) delete surface.dataset[name]
      else surface.dataset[name] = value
    }
    const expose = (list: ReadonlyArray<Body>) => {
      const staying = list.filter((body) => !body.leaving)
      const largest = staying.at(-1)
      const matches =
        latest.current.query === ""
          ? []
          : staying.filter((body) => body.code.includes(latest.current.query))
      mark("bubbles", String(staying.length))
      mark("largest", largest?.code)
      mark("largestAt", centre(largest))
      mark("matches", String(matches.length))
      mark("matchAt", centre(matches.at(-1)))
      mark(
        "ringed",
        staying.find((body) => body.code === latest.current.ringed)?.code
      )
      mark(
        "sectorLabels",
        JSON.stringify(
          Object.fromEntries(
            scene.current.boxes.map((box) => [
              box.sector,
              `${Math.round((box.left + box.right) / 2)},${Math.round((box.top + box.bottom) / 2)}`,
            ])
          )
        )
      )
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
        if (body.r >= 0.6) searched(body, body.r >= glowFrom && body.r > 14)
      }
      context.globalAlpha = 1
      scene.current.boxes = drawSectorLabels(list)
      if (top !== undefined) lifted(top)
      if (tick++ % 10 === 0) expose(list)
      frame = requestAnimationFrame(draw)
    }
    frame = requestAnimationFrame(draw)
    const unfollow = followPointer({
      surface,
      bodies: scene.current.bodies,
      pointer: scene.current,
      show: showPointer,
      pick: (code) => latest.current.onPick(code),
      labelAt: (x, y) =>
        latest.current.onPickSector &&
        Effect.runSync(labelUnder(scene.current.boxes, x, y)),
      pickSector: (sector) => latest.current.onPickSector?.(sector),
    })
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      unfollow()
    }
  }, [])

  return (
    <div ref={host} className={cn("relative overflow-hidden", className)}>
      <canvas
        ref={canvas}
        role="img"
        aria-label={`Market Bubbles: ${bubbles.length} stock codes`}
        className="absolute inset-0 size-full touch-none"
        style={{ cursor: pointerView.cursor }}
      />
      {pointerView.tip && (
        <BubbleTip
          hovered={pointerView.tip}
          view={view}
          name={names.get(pointerView.tip.figures.code)}
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
      returning: 0,
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
  const sector = sectorOf(sectors, figures.code)
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
    [
      "Buy/Sell delta",
      percent(figures.delta),
      Effect.runSync(toneClass(figures.delta)),
    ],
    [
      `Change (${view.window})`,
      percent(figures.change),
      Effect.runSync(toneClass(figures.change)),
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
        <span
          className={cn("num", Effect.runSync(toneClass(figures.dayChange)))}
        >
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
