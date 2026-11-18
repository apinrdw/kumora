import { Effect } from "effect"

import { KButton } from "@/components/k/button"
import { KInput } from "@/components/k/input"
import { KSelect } from "@/components/k/select"
import { Pressed } from "@/components/market-bubbles/pressed"
import { compact } from "@/lib/format"
import {
  FLOORS,
  RANK_CHOICES,
  type Floor,
  type RadarSettings,
} from "@/lib/order-book-radar"

const FLOOR_OPTIONS = FLOORS.map((floor) => ({
  value: String(floor),
  label: `Rp${Effect.runSync(compact(floor))}`,
}))

const CODES_OPTIONS: ReadonlyArray<{
  value: RadarSettings["codes"]
  label: string
}> = [
  { value: "all", label: "All above floor" },
  { value: "watchlist", label: "Watchlist" },
]

// A price field's number, none when blank or not a positive number.
const priceOf = (text: string) => {
  const value = Number(text)
  return text.trim() === "" || !Number.isFinite(value) || value <= 0
    ? undefined
    : value
}

function PriceField({
  label,
  placeholder,
  value,
  onChange,
}: {
  label: string
  placeholder: string
  value: number | undefined
  onChange: (value: number | undefined) => void
}) {
  return (
    <KInput
      type="number"
      inputMode="numeric"
      min={1}
      label={label}
      hideLabel
      placeholder={placeholder}
      value={value ?? ""}
      onChange={(event) => onChange(priceOf(event.target.value))}
      className="w-24"
    />
  )
}

// The scanner's toolbar: the value floor, the filters, Rank by with its
// direction, and when the order next re-sorts.
export function Toolbar({
  settings,
  onChange,
  note,
}: {
  settings: RadarSettings
  onChange: (patch: Partial<RadarSettings>) => void
  note: string
}) {
  return (
    <div
      role="toolbar"
      aria-label="Scanner settings"
      className="bg-surface flex flex-wrap items-end gap-x-3 gap-y-2 rounded-md border border-border px-2.5 py-2 text-xs"
    >
      <KSelect
        label="Value floor"
        size="xs"
        options={FLOOR_OPTIONS}
        value={String(settings.floor)}
        onValueChange={(floor) => onChange({ floor: Number(floor) as Floor })}
        className="w-28"
      />
      <Pressed
        label="Codes"
        options={CODES_OPTIONS}
        value={settings.codes}
        onPick={(codes) => onChange({ codes })}
      />
      <KInput
        type="search"
        label="Search"
        placeholder="BBCA"
        maxLength={6}
        value={settings.search}
        onChange={(event) =>
          onChange({ search: event.target.value.toUpperCase() })
        }
        className="w-28"
      />
      <div role="group" aria-label="Price" className="flex items-end gap-1.5">
        <PriceField
          label="Lowest price"
          placeholder="min"
          value={settings.priceMin}
          onChange={(priceMin) => onChange({ priceMin })}
        />
        <span className="pb-2 text-muted-foreground">–</span>
        <PriceField
          label="Highest price"
          placeholder="max"
          value={settings.priceMax}
          onChange={(priceMax) => onChange({ priceMax })}
        />
      </div>
      <div className="ml-auto flex items-end gap-1.5">
        <KSelect
          label="Rank by"
          size="xs"
          options={RANK_CHOICES}
          value={settings.rankBy}
          onValueChange={(rankBy) => onChange({ rankBy, direction: "high" })}
          className="w-40"
        />
        <KButton
          variant="secondary"
          size="sm"
          onClick={() =>
            onChange({
              direction: settings.direction === "high" ? "low" : "high",
            })
          }
        >
          {settings.direction === "high" ? "High → low" : "Low → high"}
        </KButton>
      </div>
      <span role="status" className="w-full text-muted-foreground lg:w-auto">
        {note}
      </span>
    </div>
  )
}
