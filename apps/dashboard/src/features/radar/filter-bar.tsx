import { IconBolt, IconDroplet, IconX } from "@tabler/icons-react"

import { KChip, KSelect } from "@/components/k"
import {
  CONFIDENCE_OPTIONS,
  REGIME_OPTIONS,
  SECTOR_OPTIONS,
  TIMEFRAME_OPTIONS,
  activeFilterCount,
} from "./model"
import type { Filters } from "./model"

export function FilterBar({
  filters,
  onChange,
  onReset,
  anomalyCount,
}: {
  filters: Filters
  onChange: (patch: Partial<Filters>) => void
  onReset: () => void
  /** Rows with a volume anomaly under the other filters. */
  anomalyCount: number
}) {
  const active = activeFilterCount(filters)
  return (
    <div
      role="group"
      aria-label="Filter kandidat"
      className="bg-canvas -mx-4 flex flex-col gap-2 border-b border-border px-4 py-2 md:-mx-6 md:px-6 lg:sticky lg:top-14 lg:z-10 lg:flex-row lg:flex-wrap lg:items-center"
    >
      <div className="-mx-4 flex items-center gap-2 overflow-x-auto px-4 pb-0.5 lg:mx-0 lg:overflow-visible lg:px-0 lg:pb-0 [&>*]:shrink-0">
        <KChip
          icon={IconDroplet}
          selected={filters.liquidOnly}
          onSelectedChange={(liquidOnly) => onChange({ liquidOnly })}
        >
          Likuiditas tinggi
        </KChip>
        <KChip
          icon={IconBolt}
          count={anomalyCount}
          selected={filters.volumeAnomaly}
          onSelectedChange={(volumeAnomaly) => onChange({ volumeAnomaly })}
        >
          Volume anomali
        </KChip>
        <KChip
          reset
          icon={IconX}
          count={active}
          disabled={active === 0}
          onClick={onReset}
        >
          Reset
        </KChip>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:ml-auto lg:flex lg:flex-wrap">
        <KSelect
          label="Timeframe"
          hideLabel
          options={TIMEFRAME_OPTIONS}
          value={filters.timeframe}
          onValueChange={(timeframe) => onChange({ timeframe })}
          className="lg:w-[88px]"
        />
        <KSelect
          label="Keyakinan pola"
          hideLabel
          options={CONFIDENCE_OPTIONS}
          value={filters.confidence}
          onValueChange={(confidence) => onChange({ confidence })}
          className="lg:w-[168px]"
        />
        <KSelect
          label="Sektor"
          hideLabel
          options={SECTOR_OPTIONS}
          value={filters.sector}
          onValueChange={(sector) => onChange({ sector })}
          className="lg:w-[156px]"
        />
        <KSelect
          label="Rezim net flow"
          hideLabel
          options={REGIME_OPTIONS}
          value={filters.regime}
          onValueChange={(regime) => onChange({ regime })}
          className="lg:w-[156px]"
        />
      </div>
    </div>
  )
}
