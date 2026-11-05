import type { ComponentProps } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test } from "vitest"

import {
  type ChartConfig,
  ChartContainer,
  ChartLegendContent,
  ChartStyle,
  ChartTooltipContent,
} from "@workspace/ui/components/chart"

const config: ChartConfig = {
  buy: { label: "Beli", color: "green" },
  sell: { label: "Jual", theme: { light: "red", dark: "pink" } },
  bbca: { label: "Bank Central Asia" },
}

function Icon() {
  return <svg data-testid="icon" />
}

function tooltip(props: ComponentProps<typeof ChartTooltipContent>) {
  return renderToStaticMarkup(
    <ChartContainer config={config}>
      <ChartTooltipContent {...props} />
    </ChartContainer>
  )
}

function legend(
  props: ComponentProps<typeof ChartLegendContent>,
  chartConfig: ChartConfig = config
) {
  return renderToStaticMarkup(
    <ChartContainer config={chartConfig}>
      <ChartLegendContent {...props} />
    </ChartContainer>
  )
}

const twoSeries = [
  {
    graphicalItemId: "g",
    name: "buy",
    dataKey: "buy",
    value: 1234567,
    color: "green",
  },
  {
    graphicalItemId: "g",
    name: "sell",
    dataKey: "sell",
    value: "n/a",
    color: "red",
  },
]

describe("ChartTooltipContent", () => {
  test("renders nothing when inactive or without payload", () => {
    expect(tooltip({ active: false, payload: twoSeries })).not.toContain("Beli")
    expect(tooltip({ active: true, payload: [] })).not.toContain("font-medium")
  })

  test("shows each series with its configured label and formatted value", () => {
    const html = tooltip({ active: true, payload: twoSeries })
    expect(html).toContain("Beli")
    expect(html).toContain("Jual")
    expect(html).toContain("1,234,567")
    expect(html).toContain("n/a")
  })

  test("falls back to the series name when it has no config entry", () => {
    const html = tooltip({
      active: true,
      payload: [
        { graphicalItemId: "g", name: "volume", dataKey: "volume", value: 5 },
      ],
    })
    expect(html).toContain("volume")
  })

  test("omits the value cell when the value is missing", () => {
    const html = tooltip({
      active: true,
      payload: [{ graphicalItemId: "g", name: "buy", dataKey: "buy" }],
    })
    expect(html).not.toContain("tabular-nums")
  })

  test("skips series of type none", () => {
    const html = tooltip({
      active: true,
      payload: [twoSeries[0]!, { ...twoSeries[1]!, type: "none" }],
    })
    expect(html).toContain("Beli")
    expect(html).not.toContain("Jual")
  })

  test("resolves the label from a config key matching the label string", () => {
    const html = tooltip({ active: true, payload: twoSeries, label: "bbca" })
    expect(html).toContain('<div class="font-medium">Bank Central Asia</div>')
  })

  test("shows a label string with no config entry as-is", () => {
    const html = tooltip({ active: true, payload: twoSeries, label: "Senin" })
    expect(html).toContain('<div class="font-medium">Senin</div>')
  })

  test("labelKey resolves the label through the first item's payload", () => {
    const html = tooltip({
      active: true,
      label: "ignored",
      labelKey: "ticker",
      payload: [{ ...twoSeries[0]!, payload: { ticker: "bbca" } }],
    })
    expect(html).toContain('<div class="font-medium">Bank Central Asia</div>')
    expect(html).not.toContain("ignored")
  })

  test("labelFormatter receives the resolved label and payload", () => {
    const html = tooltip({
      active: true,
      payload: twoSeries,
      label: "bbca",
      labelClassName: "lbl",
      labelFormatter: (value, payload) =>
        `${String(value)} (${payload.length})`,
    })
    expect(html).toContain(
      '<div class="font-medium lbl">Bank Central Asia (2)</div>'
    )
  })

  test("hideLabel hides the label", () => {
    const html = tooltip({
      active: true,
      payload: twoSeries,
      label: "bbca",
      hideLabel: true,
    })
    expect(html).not.toContain("Bank Central Asia")
  })

  test("formatter replaces the default item rendering", () => {
    const html = tooltip({
      active: true,
      payload: twoSeries,
      formatter: (value, name, _item, index) => (
        <b>{`${String(name)}=${String(value)}@${index}`}</b>
      ),
    })
    expect(html).toContain("<b>buy=1234567@0</b>")
    expect(html).toContain("<b>sell=n/a@1</b>")
    expect(html).not.toContain('<span class="text-muted-foreground">')
    expect(html).not.toContain("--color-bg")
  })

  test("without a label, the header shows the first series' configured label", () => {
    expect(tooltip({ active: true, payload: twoSeries })).toContain(
      '<div class="font-medium">Beli</div>'
    )
  })

  test("indicator color prefers the color prop, then the payload fill, then the item color", () => {
    expect(tooltip({ active: true, payload: [twoSeries[0]!] })).toContain(
      "--color-bg:green"
    )
    expect(
      tooltip({
        active: true,
        payload: [{ ...twoSeries[0]!, payload: { fill: "blue" } }],
      })
    ).toContain("--color-bg:blue")
    expect(
      tooltip({
        active: true,
        payload: [{ ...twoSeries[0]!, payload: { fill: "blue" } }],
        color: "gold",
      })
    ).toContain("--color-bg:gold")
  })

  test("indicator shape follows the indicator prop", () => {
    expect(tooltip({ active: true, payload: twoSeries })).toContain(
      "h-2.5 w-2.5"
    )
    expect(
      tooltip({ active: true, payload: twoSeries, indicator: "line" })
    ).toContain("w-1")
    expect(
      tooltip({ active: true, payload: twoSeries, indicator: "dashed" })
    ).toContain("border-dashed")
  })

  test("hideIndicator removes the indicator swatch", () => {
    const html = tooltip({
      active: true,
      payload: twoSeries,
      hideIndicator: true,
    })
    expect(html).not.toContain("--color-bg")
  })

  test("a configured icon replaces the indicator", () => {
    const html = renderToStaticMarkup(
      <ChartContainer config={{ buy: { label: "Beli", icon: Icon } }}>
        <ChartTooltipContent active payload={[twoSeries[0]!]} />
      </ChartContainer>
    )
    expect(html).toContain('data-testid="icon"')
    expect(html).not.toContain("--color-bg")
  })

  test("a single series with a non-dot indicator nests the label beside the value", () => {
    const html = tooltip({
      active: true,
      payload: [twoSeries[0]!],
      label: "bbca",
      indicator: "dashed",
    })
    const label = '<div class="font-medium">Bank Central Asia</div>'
    expect(html.split(label)).toHaveLength(2)
    expect(html).toContain(`<div class="grid gap-1.5">${label}<span`)
    expect(html).toContain("my-0.5")
    expect(html).toContain("items-end")
  })

  test("nameKey picks the config entry from the item payload", () => {
    const html = tooltip({
      active: true,
      nameKey: "side",
      payload: [
        {
          graphicalItemId: "g",
          name: "x",
          dataKey: "x",
          value: 1,
          payload: { side: "sell" },
        },
      ],
    })
    expect(html).toContain("Jual")
  })
})

describe("ChartLegendContent", () => {
  test("renders nothing without payload", () => {
    expect(legend({ payload: [] })).not.toContain("justify-center gap-4")
  })

  test("shows each series label with a color swatch below the chart", () => {
    const html = legend({
      payload: [
        { value: "buy", dataKey: "buy", color: "green" },
        { value: "sell", dataKey: "sell", color: "red", type: "none" },
      ],
    })
    expect(html).toContain("pt-3")
    expect(html).toContain("background-color:green")
    expect(html).toContain("Beli")
    expect(html).not.toContain("Jual")
  })

  test("verticalAlign top pads below instead of above", () => {
    const html = legend({
      verticalAlign: "top",
      payload: [{ value: "buy", dataKey: "buy", color: "green" }],
    })
    expect(html).toContain("pb-3")
  })

  test("uses the configured icon unless hideIcon is set", () => {
    const iconConfig: ChartConfig = { buy: { label: "Beli", icon: Icon } }
    const payload = [{ value: "buy", dataKey: "buy", color: "green" }]
    expect(legend({ payload }, iconConfig)).toContain('data-testid="icon"')
    const hidden = legend({ payload, hideIcon: true }, iconConfig)
    expect(hidden).not.toContain('data-testid="icon"')
    expect(hidden).toContain("background-color:green")
  })

  test("nameKey reads the config key from the legend item", () => {
    const html = legend({
      nameKey: "value",
      payload: [{ value: "sell", dataKey: "other", color: "red" }],
    })
    expect(html).toContain("Jual")
  })
})

describe("ChartStyle", () => {
  test("emits color variables per theme for configured series", () => {
    const html = renderToStaticMarkup(<ChartStyle id="c1" config={config} />)
    expect(html).toContain("[data-chart=c1]")
    expect(html).toContain("--color-buy: green;")
    expect(html).toContain("--color-sell: red;")
    expect(html).toContain(".dark [data-chart=c1]")
    expect(html).toContain("--color-sell: pink;")
    expect(html).not.toContain("--color-bbca")
  })

  test("renders nothing when no series has a color", () => {
    expect(
      renderToStaticMarkup(
        <ChartStyle id="c1" config={{ bbca: { label: "BBCA" } }} />
      )
    ).toBe("")
  })
})
