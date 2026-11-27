// The Holder map's view model (spec apinrdw/kumora#733, "View model"): the
// read turned into what the page shows, the focus's side panel, a section
// per band, or the landing view's stocks.
import type { StockCode, WibDate } from "@workspace/relay"
import { Effect } from "effect"

import type { HolderMapLink, HolderMapRead } from "@/server/holdings/holder-map"

export type Band = HolderMapLink["band"]

// One band's section of the side panel.
export interface BandSection {
  readonly band: Band
  // The band's report: the 5% band's trading day, the 1% band's above-1%
  // report; undefined when none is parsed.
  readonly date: WibDate | undefined
  // Most % first, then by name.
  readonly holders: ReadonlyArray<HolderMapLink>
  // Their summed % × 100.
  readonly totalHundredths: number
}

export interface HolderMapView {
  readonly day: WibDate | undefined
  readonly month: WibDate | undefined
  readonly focus:
    | {
        readonly code: StockCode
        readonly issuerName: string | undefined
        // The 5% band, then the 1% band.
        readonly bands: readonly [BandSection, BandSection]
      }
    | undefined
  readonly mostHeld: HolderMapRead["mostHeld"]
}

const section = (
  band: Band,
  date: WibDate | undefined,
  links: ReadonlyArray<HolderMapLink>
) =>
  Effect.sync((): BandSection => {
    const holders = links
      .filter((link) => link.band === band)
      .sort(
        (a, b) =>
          b.percentageHundredths - a.percentageHundredths ||
          a.name.localeCompare(b.name)
      )
    return {
      band,
      date,
      holders,
      totalHundredths: holders.reduce(
        (sum, { percentageHundredths }) => sum + percentageHundredths,
        0
      ),
    }
  })

export const holderMapView = Effect.fnUntraced(function* (
  read: HolderMapRead
): Effect.fn.Return<HolderMapView> {
  const { day, month, focus, links, mostHeld } = read
  return {
    day,
    month,
    focus:
      focus === undefined
        ? undefined
        : {
            code: focus.code,
            issuerName: focus.issuerName,
            bands: [
              yield* section("5%", day, links),
              yield* section("1%", month, links),
            ],
          },
    mostHeld,
  }
})
