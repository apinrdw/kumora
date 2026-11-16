import type { StockCode } from "@workspace/relay"
import { cn } from "@workspace/ui/lib/utils"
import { Effect } from "effect"
import { useEffect, useRef, useState } from "react"

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
import { compact, lots, pct, price } from "@/lib/format"

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

const NO_NAMES: ReadonlyMap<StockCode, string> = new Map()

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
// brings. A code that leaves shrinks out and one that joins grows in.
// Hovering a bubble grows it and shows its figures; dragging one shoves its
// neighbours aside; a click hands its code to `onPick`. A `search` rings the
// codes that contain it and dims the rest, without moving any. The page and
// Market Live's panel both draw with it.
export function BubbleCanvas({
  bubbles,
  view,
  names = NO_NAMES,
  search = "",
  onPick,
  className,
}: {
  bubbles: ReadonlyArray<BubbleFigures>
  view: BubbleView
  names?: ReadonlyMap<StockCode, string>
  search?: string
  onPick: (code: StockCode) => void
  className?: string
}) {
  const host = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const bodies = useRef(new Map<StockCode, Body>())
  const pointer = useRef<Pointer>({ hovered: undefined, press: undefined })
  const [pointerView, showPointer] = useState<PointerView>(NO_POINTER)
  // The latest props the frame loop reads: who a click goes to, and the
  // search, as a code would contain it.
  const latest = useRef({ onPick, query: "" })
  useEffect(() => {
    latest.current = { onPick, query: search.trim().toUpperCase() }
  }, [onPick, search])
  // Each code's logo once asked for: loading or loaded, or null once it
  // failed (no logo for the code), so it is asked for once a page.
  const logos = useRef(new Map<StockCode, HTMLImageElement | null>())

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
    const held = bodies.current
    const shown = new Set<StockCode>()
    for (const figures of bubbles) {
      shown.add(figures.code)
      const labels: Labels = {
        metric:
          view.colour === "delta" || figures.change !== undefined
            ? Effect.runSync(
                pct(view.colour === "delta" ? figures.delta : figures.change!)
              )
            : "—",
        size: Effect.runSync(sizeFigure(view.size, figures.size)),
      }
      const targetR = Math.max(minRadius, k * Math.sqrt(figures.size))
      const targetTone = Effect.runSync(bubbleTone(figures, view)) ?? 0
      const body = held.get(figures.code)
      if (body === undefined) {
        // Grows in near the centre; its neighbours make room.
        const angle = Math.random() * Math.PI * 2
        held.set(figures.code, {
          code: figures.code,
          x: width / 2 + Math.cos(angle) * width * 0.1,
          y: height / 2 + Math.sin(angle) * height * 0.1,
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
        continue
      }
      body.targetR = targetR
      body.targetTone = targetTone
      body.figures = figures
      body.labels = labels
      body.leaving = false
    }
    for (const [code, body] of held) if (!shown.has(code)) body.leaving = true
    // The tooltip follows its bubble's new figures.
    showPointer((last) => {
      const code = pointer.current.hovered
      const body = code === undefined ? undefined : held.get(code)
      if (last.tip === undefined || body === undefined || body.leaving)
        return last.tip === undefined ? last : NO_POINTER
      return { ...last, tip: { ...last.tip, figures: body.figures } }
    })
  }, [bubbles, view])

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
        body.code === pointer.current.hovered
          ? Math.max(body.r * HOVER_SCALE, HOVER_MIN_RADIUS)
          : body.r
      body.shownR += (shown - body.shownR) * HOVER_EASE
    }

    const dragging = () => Effect.runSync(draggedOf(pointer.current))

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

    // One body's frame: its eases, then the pull toward the centre, or the
    // pointer while it is dragged. A wide canvas pulls less across, so the
    // cluster fills it.
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
      const pullX = (width / 2 - body.x) * (height / Math.max(width, 1))
      const pullY = height / 2 - body.y
      if (body.returning > 0) returnHome(body, pullX, pullY)
      else {
        body.vx = (body.vx + pullX * 0.0016) * 0.82
        body.vy = (body.vy + pullY * 0.0016) * 0.82
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
      for (const body of list) move(body)
      collide(list)
      collide(list)
      for (const body of list) {
        body.x = Math.min(Math.max(body.x, body.r), width - body.r)
        body.y = Math.min(Math.max(body.y, body.r), height - body.r)
        if (body.leaving && body.r < 0.5) bodies.current.delete(body.code)
      }
    }

    // The code's logo, once it has loaded; the first ask starts the load.
    const logoOf = (code: StockCode) => {
      const held = logos.current
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
      if (match) ring(body.x, body.y, body.r, body.r > 16 ? 3 : 2)
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
    // and the search's match count and its largest match's centre.
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
    }

    let frame = 0
    let tick = 0
    const draw = () => {
      const list = [...bodies.current.values()]
      step(list)
      context.setTransform(ratio, 0, 0, ratio, 0, 0)
      context.clearRect(0, 0, width, height)
      list.sort((a, b) => a.r - b.r)
      const glowFrom =
        list.length > GLOWING ? list[list.length - GLOWING]!.r : 0
      let top: Body | undefined
      for (const body of list) {
        if (body.code === pointer.current.hovered) {
          top = body
          continue
        }
        if (body.r >= 0.6) searched(body, body.r >= glowFrom && body.r > 14)
      }
      context.globalAlpha = 1
      if (top !== undefined) lifted(top)
      if (tick++ % 10 === 0) expose(list)
      frame = requestAnimationFrame(draw)
    }
    frame = requestAnimationFrame(draw)
    const unfollow = followPointer({
      surface,
      bodies: bodies.current,
      pointer: pointer.current,
      show: showPointer,
      pick: (code) => latest.current.onPick(code),
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
        />
      )}
    </div>
  )
}

const TONE_CLASS = (n: number | undefined) =>
  n === undefined || n === 0 ? "" : n > 0 ? "text-up" : "text-down"

// The hovered bubble's figures: its code and day change, its company, its
// price, then the window's value, volume, frequency, Buy/Sell delta and
// change.
function BubbleTip({
  hovered,
  view,
  name,
}: {
  hovered: Hovered
  view: BubbleView
  name: string | undefined
}) {
  const { figures } = hovered
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
      {name !== undefined && name !== "" && (
        <div className="mb-1 truncate text-muted-foreground">{name}</div>
      )}
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
