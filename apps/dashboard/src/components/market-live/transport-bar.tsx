import type { MarketPhase, RelayGap } from "@workspace/relay"
import { DateTime } from "effect"
import { cn } from "@workspace/ui/lib/utils"
import { useEffect } from "react"

import { tapeTime } from "@/lib/format"
import { SPEEDS, scrubbedTo } from "@/lib/replay"

import { useReplay, type ReplayCursor } from "./replay-cursor"

// The scrubber's band colours: the sessions trade, the auctions match, the
// break and post-trading are quiet.
const BAND: Record<MarketPhase, string> = {
  "pre-opening": "bg-warning/25",
  "session-1": "bg-info/25",
  break: "bg-muted",
  "session-2": "bg-info/25",
  "pre-closing": "bg-warning/25",
  "post-trading": "bg-neutral/25",
  closed: "bg-muted",
  holiday: "bg-muted",
}

const BAND_LABEL: Record<MarketPhase, string> = {
  "pre-opening": "Pre-opening",
  "session-1": "Session 1",
  break: "Break",
  "session-2": "Session 2",
  "pre-closing": "Pre-closing",
  "post-trading": "Post-trading",
  closed: "Closed",
  holiday: "Holiday",
}

// Space plays or pauses, unless a control that takes Space has focus.
const takesSpace = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    target.closest("button, a, select, textarea, input:not([type=range])") !==
      null)

/**
 * A recorded day's transport bar, under the chart: Play/Pause (Space), the
 * replay speeds, and a 08:45–16:15 scrubber over the day's market phases,
 * with its relay gaps shaded as not recorded.
 */
export function TransportBar({
  cursor,
  gaps,
}: {
  cursor: ReplayCursor
  gaps: ReadonlyArray<RelayGap>
}) {
  const { start, close, bands } = cursor.day
  const at = useReplay(cursor, (state) => state.at)
  const playing = useReplay(cursor, (state) => state.playing)
  const speed = useReplay(cursor, (state) => state.speed)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.code !== "Space" || event.repeat || takesSpace(event.target))
        return
      event.preventDefault()
      cursor.toggle()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [cursor])

  const span = close - start
  const percent = (instant: number) =>
    `${((Math.min(close, Math.max(start, instant)) - start) / span) * 100}%`

  return (
    <div
      role="group"
      aria-label="Replay"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-border px-3 py-2 text-[12px]"
    >
      <button
        type="button"
        onClick={cursor.toggle}
        aria-keyshortcuts="Space"
        className="w-16 rounded border border-border px-2 py-1 font-semibold"
      >
        {playing ? "Pause" : "Play"}
      </button>
      <div role="group" aria-label="Replay speed" className="flex gap-1">
        {SPEEDS.map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={speed === option}
            onClick={() => cursor.setSpeed(option)}
            className={cn(
              "rounded px-1.5 py-1 tabular-nums",
              speed === option
                ? "bg-foreground text-background"
                : "text-muted-foreground"
            )}
          >
            {option}×
          </button>
        ))}
      </div>
      <span className="w-16 font-semibold tabular-nums" aria-hidden>
        {tapeTime(at)}
      </span>
      <div className="flex min-w-48 flex-1 flex-col gap-0.5">
        <div className="relative h-5">
          <div className="absolute inset-x-0 top-1.5 h-2 overflow-hidden rounded-sm">
            {bands.map((band) => (
              <i
                key={band.from}
                title={BAND_LABEL[band.phase]}
                className={cn("absolute inset-y-0", BAND[band.phase])}
                style={{
                  left: percent(band.from),
                  width: `calc(${percent(band.to)} - ${percent(band.from)})`,
                }}
              />
            ))}
            {gaps.map((gap) => {
              const from = DateTime.toEpochMillis(gap.from)
              const to =
                gap.to === undefined ? close : DateTime.toEpochMillis(gap.to)
              return (
                <i
                  key={from}
                  title="Not recorded"
                  data-gap
                  className="absolute inset-y-0 bg-[repeating-linear-gradient(135deg,var(--text-muted)_0_2px,transparent_2px_5px)] opacity-60"
                  style={{
                    left: percent(from),
                    width: `calc(${percent(to)} - ${percent(from)})`,
                  }}
                />
              )
            })}
          </div>
          <input
            type="range"
            aria-label="Replay cursor"
            aria-valuetext={`${tapeTime(at)} WIB`}
            min={start}
            max={close}
            step={1_000}
            value={at}
            onChange={(event) =>
              cursor.seek(scrubbedTo(cursor.day, Number(event.target.value)))
            }
            className="absolute inset-0 w-full cursor-pointer appearance-none bg-transparent accent-foreground"
          />
        </div>
        <div className="flex justify-between text-[10px] text-muted-foreground tabular-nums">
          <span>08:45</span>
          <span>16:15</span>
        </div>
      </div>
    </div>
  )
}
