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
// Hovering a bubble grows it and shows its figures; a click hands its code to
// `onPick`. The page and Market Live's panel both draw with it.
export function BubbleCanvas({
  bubbles,
  view,
  names = NO_NAMES,
  onPick,
  className,
}: {
  bubbles: ReadonlyArray<BubbleFigures>
  view: BubbleView
  names?: ReadonlyMap<StockCode, string>
  onPick: (code: StockCode) => void
  className?: string
}) {
  const host = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const bodies = useRef(new Map<StockCode, Body>())
  const hoveredCode = useRef<StockCode | undefined>(undefined)
  // Each code's logo once asked for: loading or loaded, or null once it
  // failed (no logo for the code), so it is asked for once a page.
  const logos = useRef(new Map<StockCode, HTMLImageElement | null>())
  const pick = useRef(onPick)
  const [hovered, setHovered] = useState<Hovered | undefined>(undefined)

  useEffect(() => {
    pick.current = onPick
  }, [onPick])

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
    setHovered((last) => {
      const code = hoveredCode.current
      const body = code === undefined ? undefined : held.get(code)
      if (last === undefined || body === undefined || body.leaving)
        return undefined
      return { ...last, figures: body.figures }
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

    // One body's frame: its radius, tone and hover ease, and the pull toward
    // the centre. A wide canvas pulls less across, so the cluster fills it.
    const move = (body: Body) => {
      body.r += ((body.leaving ? 0 : body.targetR) - body.r) * RADIUS_EASE
      body.tone += (body.targetTone - body.tone) * TONE_EASE
      const shown =
        body.code === hoveredCode.current
          ? Math.max(body.r * HOVER_SCALE, HOVER_MIN_RADIUS)
          : body.r
      body.shownR += (shown - body.shownR) * HOVER_EASE
      body.vx += (width / 2 - body.x) * 0.0016 * (height / Math.max(width, 1))
      body.vy += (height / 2 - body.y) * 0.0016
      body.vx *= 0.82
      body.vy *= 0.82
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
        if (body.code === hoveredCode.current) {
          top = body
          continue
        }
        if (body.r < 0.6) continue
        disc(body, body.r, body.r >= glowFrom && body.r > 14)
        label(body, body.r)
      }
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
    for (const body of bodies.current.values()) {
      if (body.leaving) continue
      const reach = body.code === hoveredCode.current ? body.shownR : body.r
      if (Math.hypot(body.x - x, body.y - y) > reach) continue
      if (found === undefined || body.r < found.r) found = body
    }
    return found
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
  const pressedAt = useRef<{ x: number; y: number } | undefined>(undefined)

  return (
    <div ref={host} className={cn("relative overflow-hidden", className)}>
      <canvas
        ref={canvas}
        role="img"
        aria-label={`Market Bubbles: ${bubbles.length} stock codes`}
        className="absolute inset-0 size-full"
        style={{ cursor: hovered === undefined ? "default" : "pointer" }}
        onPointerMove={(event) => {
          const at = pointAt(event)
          const body = hit(at.x, at.y)
          hoveredCode.current = body?.code
          setHovered(body && { figures: body.figures, ...at })
        }}
        onPointerLeave={() => {
          hoveredCode.current = undefined
          setHovered(undefined)
        }}
        onPointerDown={(event) => {
          pressedAt.current = pointAt(event)
        }}
        onPointerUp={(event) => {
          const from = pressedAt.current
          pressedAt.current = undefined
          if (from === undefined) return
          const at = pointAt(event)
          if (Math.hypot(at.x - from.x, at.y - from.y) > CLICK_SLOP) return
          const body = hit(at.x, at.y)
          if (body !== undefined) pick.current(body.code)
        }}
      />
      {hovered && (
        <BubbleTip
          hovered={hovered}
          view={view}
          name={names.get(hovered.figures.code)}
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
