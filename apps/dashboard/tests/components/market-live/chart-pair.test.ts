// @vitest-environment happy-dom
import { Effect } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest"
import type {
  IChartApi,
  ISeriesApi,
  SeriesType,
  Time,
} from "lightweight-charts"
import { vi } from "vitest"

import { makeChartPair } from "@/components/market-live/chart-pair"
import type { BarRange } from "@/lib/chart-nav"

// A chart as the pair sees one of Lightweight Charts 5.2.1's:
// - it reports a changed range at its next paint, or sooner to whoever reads
//   the range, and only to the handlers subscribed by then;
// - a range set on it applies at its next paint;
// - its own handlers hear a wheel after the page's capturing listeners and
//   before its bubbling ones, and scroll at once.
const chartShowing = (opening: BarRange | null) => {
  let shown = opening
  let reported = opening
  let queued: BarRange | undefined
  const handlers = new Set<(range: BarRange | null) => void>()
  const report = () => {
    if (reported === shown) return
    reported = shown
    for (const handler of handlers) handler(shown)
  }
  const shift = (bars: number) => {
    if (shown !== null) shown = { from: shown.from + bars, to: shown.to + bars }
  }
  const element = document.body.appendChild(document.createElement("div"))
  Object.defineProperty(element, "clientWidth", {
    get: () => WIDTH.now,
    configurable: true,
  })
  const own = element.appendChild(document.createElement("div"))
  own.addEventListener("wheel", (event) => {
    // A vertical wheel zooms: the width changes, then the range shifts to
    // keep the bar under the pointer.
    if (event.deltaY !== 0 && shown !== null) {
      shown = { from: shown.from + 2, to: shown.to }
      report()
      shift(-0.5)
    }
    shift(event.deltaX)
  })
  const fire = (target: EventTarget, event: Event) =>
    void target.dispatchEvent(event)
  const chart = {
    timeScale: () => ({
      getVisibleLogicalRange: () => {
        report()
        return shown
      },
      setVisibleLogicalRange: (range: BarRange) => {
        queued = range
      },
      subscribeVisibleLogicalRangeChange: (
        handler: (range: BarRange | null) => void
      ) => handlers.add(handler),
      unsubscribeVisibleLogicalRangeChange: (
        handler: (range: BarRange | null) => void
      ) => handlers.delete(handler),
    }),
    subscribeCrosshairMove() {},
    unsubscribeCrosshairMove() {},
    subscribeClick() {},
    unsubscribeClick() {},
  }
  const series = { attachPrimitive() {}, detachPrimitive() {} }
  return {
    side: {
      chart: chart as unknown as IChartApi,
      series: series as unknown as ISeriesApi<SeriesType, Time>,
      element,
    },
    // The range drawn, without reading it as the page would.
    range: () => shown,
    paint: () => {
      if (queued !== undefined) shown = queued
      queued = undefined
      report()
    },
    // The range moves by `bars`, its width kept: a step of a drag, or data.
    shift,
    show: (range: BarRange) => {
      shown = range
    },
    rest: () => {
      fire(own, new PointerEvent("pointerenter", { pointerType: "mouse" }))
      fire(
        own,
        new PointerEvent("pointermove", { pointerType: "mouse", bubbles: true })
      )
    },
    press: () =>
      fire(
        own,
        new PointerEvent("pointerdown", { pointerType: "mouse", bubbles: true })
      ),
    // A right click, whose button the page may never hear come up.
    rightClick: () =>
      fire(
        own,
        new PointerEvent("pointerdown", {
          pointerType: "mouse",
          button: 2,
          bubbles: true,
        })
      ),
    // The button comes up wherever the pointer is by then: off the chart.
    release: () =>
      fire(
        document.body,
        new PointerEvent("pointerup", { pointerType: "mouse", bubbles: true })
      ),
    wheel: (delta: { readonly x?: number; readonly y?: number }) =>
      fire(
        own,
        new WheelEvent("wheel", {
          deltaX: delta.x ?? 0,
          deltaY: delta.y ?? 0,
          bubbles: true,
        })
      ),
    touch: () => {
      fire(
        own,
        new PointerEvent("pointerdown", { pointerType: "touch", bubbles: true })
      )
      fire(own, new TouchEvent("touchstart", { bubbles: true }))
    },
    lift: () => {
      fire(own, new TouchEvent("touchend", { touches: [], bubbles: true }))
      fire(
        document.body,
        new PointerEvent("pointerup", { pointerType: "touch", bubbles: true })
      )
    },
  }
}
type FakeChart = ReturnType<typeof chartShowing>

// Each chart's element width, and the observers watching it.
const WIDTH = { now: 800 }
const observers: Array<() => void> = []
const detaches: Array<() => void> = []

beforeEach(() => {
  vi.useFakeTimers()
  WIDTH.now = 800
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(resized: () => void) {
        observers.push(resized)
      }
      observe() {}
      disconnect() {}
    }
  )
})

afterEach(() => {
  for (const detach of detaches.splice(0)) detach()
  observers.length = 0
  document.body.replaceChildren()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const COLORS = { shade: "#0001", edge: "#000" }
// The footprint chart draws 70 minutes, a bar each.
const MINUTES = Array.from({ length: 70 }, (_, index) => index * 60_000)

// The candle chart on 131 bars and the footprint chart on its 10 minutes,
// attached to one pair.
const paired = (
  candles = chartShowing({ from: -65, to: 65 }),
  footprint = chartShowing({ from: 52, to: 61 })
) => {
  const pair = Effect.runSync(makeChartPair())
  detaches.push(
    pair.attachCandles(candles.side, COLORS),
    pair.attachFootprint({ ...footprint.side, minutes: () => MINUTES })
  )
  // An animation frame: the pair's fit, then each chart's paint.
  const frame = () => {
    vi.advanceTimersToNextFrame()
    candles.paint()
    footprint.paint()
  }
  // A mouse drag of `chart`, a frame a step.
  const drag = (chart: FakeChart, ...steps: ReadonlyArray<number>) => {
    chart.press()
    for (const bars of steps) {
      chart.shift(bars)
      frame()
    }
    chart.release()
    frame()
  }
  return { pair, candles, footprint, frame, drag }
}

describe("a pan gesture on one chart moves the other by the same bars", () => {
  it("a mouse drag on the candle chart whose data arrived after it attached", () => {
    const { candles, footprint, frame, drag } = paired(chartShowing(null))
    candles.show({ from: -65, to: 65 })
    frame()

    drag(candles, -5, -3)

    expect(footprint.range()).toEqual({ from: 44, to: 53 })
  })

  it("a mouse drag on the candle chart, from its first bar, when the candle chart was drawn before it attached", () => {
    const { candles, footprint, drag } = paired()

    drag(candles, -5)

    expect(footprint.range()).toEqual({ from: 47, to: 56 })
  })

  it("the last step of a drag, painted after the button is up", () => {
    const { candles, footprint, frame } = paired()

    candles.press()
    candles.shift(-5)
    frame()
    candles.shift(-3)
    candles.release()
    frame()
    frame()

    expect(footprint.range()).toEqual({ from: 44, to: 53 })
  })

  it("a horizontal wheel on the candle chart, each notch before the last one is painted", () => {
    const { candles, footprint, frame } = paired()

    candles.wheel({ x: 2 })
    candles.wheel({ x: 2 })
    frame()
    candles.wheel({ x: 1 })
    frame()
    frame()

    expect(footprint.range()).toEqual({ from: 57, to: 66 })
  })

  it("a touch drag on the footprint chart, and its coast after the finger lifts", () => {
    const { candles, footprint, frame } = paired()

    footprint.touch()
    footprint.shift(-2)
    frame()
    footprint.lift()
    // Lightweight Charts keeps the chart moving for a second or two.
    for (const bars of [-1, -0.5, -0.25]) {
      vi.advanceTimersByTime(300)
      footprint.shift(bars)
      frame()
    }
    frame()

    expect(candles.range()).toEqual({ from: -68.75, to: 61.25 })
  })

  it("through a new minute that scrolls both charts mid-drag", () => {
    const { candles, footprint, frame } = paired()

    candles.press()
    candles.shift(-5)
    frame()
    candles.shift(1)
    footprint.shift(1)
    frame()
    candles.shift(-3)
    frame()
    candles.release()
    frame()

    expect(candles.range()).toEqual({ from: -72, to: 58 })
    expect(footprint.range()).toEqual({ from: 45, to: 54 })
  })
})

describe("a zoom", () => {
  it("by a vertical wheel on the footprint chart leaves the candle chart where it was", () => {
    const { candles, footprint, frame } = paired()

    footprint.wheel({ y: -100 })
    frame()
    frame()

    expect(footprint.range()).toEqual({ from: 53.5, to: 60.5 })
    expect(candles.range()).toEqual({ from: -65, to: 65 })
  })
})

// What the pointer did last on the candle chart before the range changed.
const BEFORE: Record<string, (charts: ReturnType<typeof paired>) => void> = {
  "the pointer resting on the candle chart": ({ candles }) => candles.rest(),
  "a right click on the candle chart": ({ candles }) => candles.rightClick(),
  "a finished drag on the candle chart": ({ candles, drag }) =>
    drag(candles, -4),
  "a finished wheel pan on the candle chart": ({ candles, frame }) => {
    candles.wheel({ x: -4 })
    frame()
    frame()
  },
  "a touch pan on the candle chart that has coasted to a stop": ({
    candles,
    frame,
  }) => {
    candles.touch()
    candles.shift(-4)
    frame()
    candles.lift()
    frame()
    vi.advanceTimersByTime(3_000)
  },
}

// Each way the candle chart's range moves, its width kept, with no gesture on
// it.
const UNPANNED: Record<string, (candles: FakeChart) => void> = {
  "a new minute scrolls the candle chart a bar on": (candles) =>
    candles.shift(1),
  "a dropped minute redraws the candle chart a bar back": (candles) =>
    candles.shift(-1),
  "a relay gap's minutes appear in the candle chart": (candles) =>
    candles.shift(3),
  "a sweep picked in the log centres the candle chart on its minute": (
    candles
  ) => {
    const { from, to } = candles.range()!
    candles.side.chart
      .timeScale()
      .setVisibleLogicalRange({ from: from - 20, to: to - 20 })
  },
}

describe("a range change with no gesture moves its own chart alone", () => {
  for (const [before, pointer] of Object.entries(BEFORE))
    for (const [change, apply] of Object.entries(UNPANNED))
      it(`${change}, after ${before}: the footprint chart stays`, () => {
        const charts = paired()
        pointer(charts)
        const settled = charts.footprint.range()

        apply(charts.candles)
        charts.frame()
        charts.frame()

        expect(charts.footprint.range()).toEqual(settled)
      })

  it("a new minute scrolls both charts a bar on, the footprint chart having led last and the pointer resting on the candle chart: the footprint chart goes on one bar", () => {
    const { candles, footprint, frame, drag } = paired()
    drag(footprint, -3)
    candles.rest()

    candles.shift(1)
    footprint.shift(1)
    frame()
    frame()

    expect(footprint.range()).toEqual({ from: 50, to: 59 })
  })

  it("new minutes scrolled both charts on since the footprint chart's window was set: the next drag on the candle chart moves the footprint chart from where it is", () => {
    const { pair, candles, footprint, frame, drag } = paired()
    pair.jumpTo(57 * 60_000)
    frame()
    frame()
    for (const _minute of [1, 2]) {
      candles.shift(1)
      footprint.shift(1)
      frame()
    }

    drag(candles, -5)

    expect(footprint.range()).toEqual({ from: 50, to: 59 })
  })
})

describe("the footprint chart's own refit moves the footprint chart alone", () => {
  // Each with a gesture on the footprint chart just before, so the footprint
  // chart led last.
  const REFITS: Record<
    string,
    (charts: ReturnType<typeof paired>) => BarRange
  > = {
    "a jump to a picked sweep's minute": ({ pair }) => {
      pair.jumpTo(30 * 60_000)
      return { from: 26, to: 35 }
    },
    "a recorded day's cursor moving to another minute": ({ pair }) => {
      pair.showUpTo(30 * 60_000)
      return { from: 21, to: 30 }
    },
    "a new width": () => {
      WIDTH.now = 600
      for (const resized of observers) resized()
      // Around the middle of 49 to 58, on whole minutes.
      return { from: 50, to: 59 }
    },
  }
  for (const [refit, apply] of Object.entries(REFITS))
    it(`${refit}, after a drag on the footprint chart: the candle chart stays`, () => {
      const charts = paired()
      charts.drag(charts.footprint, -3)
      const settled = charts.candles.range()

      const window = apply(charts)
      charts.frame()
      charts.frame()

      expect(charts.footprint.range()).toEqual(window)
      expect(charts.candles.range()).toEqual(settled)
    })

  it("a jump painted after the pointer went down on the footprint chart: the candle chart stays", () => {
    const { pair, candles, footprint, frame } = paired()
    pair.jumpTo(30 * 60_000)
    vi.advanceTimersToNextFrame()

    footprint.press()
    frame()
    footprint.release()
    frame()

    expect(footprint.range()).toEqual({ from: 26, to: 35 })
    expect(candles.range()).toEqual({ from: -65, to: 65 })
  })
})

describe("a drag on the footprint chart begun before its jump is painted", () => {
  it("moves the candle chart by the drag alone, not by the jump", () => {
    const { pair, candles, footprint, frame } = paired()
    pair.jumpTo(30 * 60_000)
    vi.advanceTimersToNextFrame()

    footprint.press()
    frame()
    footprint.shift(-2)
    frame()
    footprint.release()
    frame()

    expect(footprint.range()).toEqual({ from: 24, to: 33 })
    expect(candles.range()).toEqual({ from: -67, to: 63 })
  })
})

describe("a chart drawn before it attached", () => {
  // The e2e specs measure a pan from these marks.
  it("has its range marked on its element", () => {
    const { candles } = paired()

    expect(candles.side.element.dataset).toMatchObject({
      from: "-65.00",
      to: "65.00",
    })
  })
})
