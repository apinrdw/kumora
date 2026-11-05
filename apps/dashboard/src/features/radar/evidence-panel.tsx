import { IconArrowRight } from "@tabler/icons-react"
import { Link } from "@tanstack/react-router"

import {
  KAIExplanation,
  KButton,
  KChartPanel,
  KEmptyState,
  KSignalCard,
  PriceChart,
} from "@/components/k"
import { idr, plain } from "@/lib/format"
import { LIVE_PAGE_PATH, LIVE_PAGE_SEARCH } from "@/relay/routes"
import type { Candidate, RadarSnapshot } from "./schema"

export function EvidencePanel({
  snapshot,
  candidate,
}: {
  snapshot: Pick<
    RadarSnapshot,
    "aiInputs" | "aiLimitations" | "asOf" | "computedAt" | "modelVersion"
  >
  candidate: Candidate | undefined
}) {
  if (!candidate) {
    return (
      <KEmptyState
        kind="no-result"
        title="Pilih kandidat"
        description="Klik baris di tabel untuk melihat bukti, bukti berlawanan, dan penjelasan model."
        className="max-w-none"
      />
    )
  }
  const c = candidate
  const first = c.history[0].price
  return (
    <div className="grid items-start gap-3 lg:max-[1439px]:grid-cols-2">
      <div className="flex flex-col gap-3">
        <KSignalCard
          ticker={c.symbol}
          name={c.name}
          signal={c.ai}
          confidenceScore={c.confidence}
          evidence={c.evidence}
          counterEvidence={c.counter}
          freshness="demo"
          asOf={snapshot.asOf}
          modelVersion={snapshot.modelVersion}
          computedAt={snapshot.computedAt}
        />
        <div className="flex flex-wrap gap-2">
          <KButton
            variant="ghost"
            size="sm"
            nativeButton={false}
            render={
              <Link
                to={LIVE_PAGE_PATH}
                search={{ [LIVE_PAGE_SEARCH.symbol]: c.symbol }}
              />
            }
            className="ml-auto text-primary"
          >
            Buka detail
            <IconArrowRight aria-hidden stroke={1.75} className="size-4" />
          </KButton>
        </div>
      </div>
      <div className="flex flex-col gap-3">
        <KChartPanel
          title={`${c.symbol} · 20 sesi`}
          freshness="demo"
          asOf={snapshot.asOf}
          source="Feed harga"
          unit="Rp per saham"
          summary={`Harga penutupan harian ${c.symbol} selama 20 sesi, dari ${idr(first)} pada ${c.history[0].label} ke ${idr(c.last)} pada 23 Okt, dengan volume hari ini ${plain(c.volx, 1)} kali rata-rata.`}
          legend={[
            { label: "Harga", color: "price" },
            { label: "Volume", color: "volume", mark: "bar" },
          ]}
          className="p-4"
        >
          <PriceChart data={c.history} height={160} showVwap={false} />
        </KChartPanel>
        <KAIExplanation
          key={c.symbol}
          modelVersion={snapshot.modelVersion}
          computedAt={snapshot.computedAt}
          hypothesis={c.hypothesis || undefined}
          inputs={snapshot.aiInputs}
          contributions={c.contributions}
          limitations={snapshot.aiLimitations}
        />
      </div>
    </div>
  )
}
