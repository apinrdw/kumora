// @vitest-environment happy-dom
import {
  BrokerCode,
  StockCode,
  OrderNumber,
  TradeNumber,
  type InvestorType,
  type Sweep,
  type SweepBroker,
  type SweepOrders,
  type SweepPiece,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, expect, test } from "vitest"

import { SweepLog } from "@/components/market-live/sweep-log"
import { makeSweepStore } from "@/components/market-live/sweep-store"

// React's `act` warns outside a test environment that declares itself.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const BBCA = StockCode.make("BBCA")

const sweep = (id: string, wib: string, side: Sweep["side"]): Sweep => ({
  side,
  firstTrade: TradeNumber.make(id),
  time: DateTime.makeUnsafe(`2026-11-20T${wib}+07:00`),
  first: OrderNumber.make(9_000),
  last: OrderNumber.make(9_000),
  lots: 30,
  value: 27_000_000,
  trades: 3,
})

const broker = (
  code: string,
  investorType: InvestorType,
  lots: number
): SweepBroker => ({ code: BrokerCode.make(code), investorType, lots })

const piece = (
  whole: Sweep,
  aggressor: ReadonlyArray<SweepBroker>,
  other: ReadonlyArray<SweepBroker>,
  orders?: SweepOrders
): SweepPiece => ({
  ...whole,
  aggressor,
  other,
  ...(orders === undefined ? {} : { orders }),
})

const run = (count: number): SweepOrders => ({
  count,
  first: OrderNumber.make(1_515_610),
  last: OrderNumber.make(1_515_610 + count - 1),
  biggestPassiveLots: 20,
})

const mounted: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const unmount of mounted.splice(0)) await unmount()
})

// The log of a recorded day holding `pieces`, each its own whole sweep.
async function renderLog(pieces: ReadonlyArray<SweepPiece>) {
  const store = Effect.runSync(makeSweepStore(BBCA))
  store.answer(0, { code: BBCA, sweeps: pieces })
  store.answerBrokers(
    {
      code: BBCA,
      sweeps: pieces.map((each) => ({
        firstTrade: each.firstTrade,
        pieces: [each],
      })),
      complete: true,
    },
    false
  )
  store.setTopN(100)
  const root = createRoot(
    document.body.appendChild(document.createElement("div"))
  )
  await act(() =>
    root.render(
      <SweepLog
        store={store}
        withBrokers
        bigOnly={false}
        onBigOnly={() => {}}
      />
    )
  )
  mounted.push(() => act(async () => root.unmount()))
}

// A row's Buyer and Seller cells, as read.
const cells = (id: string) => {
  const row = document.querySelector(`[data-sweep-id="${id}"]`)!
  return {
    buyer: row.querySelector('[data-column="buyer"]')?.textContent,
    seller: row.querySelector('[data-column="seller"]')?.textContent,
  }
}

test("the broker columns are Buyer and Seller", async () => {
  await renderLog([])
  const log = document.querySelector('[aria-label="Sweep log"]')!.textContent
  expect(log).toContain("Buyer")
  expect(log).toContain("Seller")
  expect(log).not.toContain("Aggressor")
  expect(log).not.toContain("Other side")
})

test("a buy row's Buyer is its aggressor and its Seller the lead seller; a sell row's the reverse", async () => {
  const buy = sweep("10", "10:23:17", "buy")
  const sell = sweep("20", "10:23:18", "sell")
  await renderLog([
    piece(
      buy,
      [broker("AK", "F", 30)],
      [broker("CC", "D", 20), broker("BK", "D", 10)]
    ),
    piece(sell, [broker("XL", "D", 30)], [broker("YP", "D", 30)]),
  ])
  expect(cells("10")).toEqual({ buyer: "AK [F]", seller: "CC [D] +1" })
  expect(cells("20")).toEqual({ buyer: "YP [D]", seller: "XL [D]" })
})

test("an Auction row's Buyer is its lead buyer and its Seller its lead seller", async () => {
  const auction = sweep("5", "08:58:00", "none")
  await renderLog([
    piece(
      auction,
      [broker("AK", "F", 20), broker("BK", "D", 10)],
      [broker("CC", "D", 30)]
    ),
  ])
  expect(cells("5")).toEqual({ buyer: "AK [F] +1", seller: "CC [D]" })
})

test("an order run of 2 or more orders shows ×N after its aggressor broker; one order or a per-broker piece shows none", async () => {
  await renderLog([
    piece(
      sweep("30", "10:23:18", "sell"),
      [broker("XL", "D", 30)],
      [broker("YP", "D", 30)],
      run(22)
    ),
    piece(
      sweep("40", "10:23:19", "buy"),
      [broker("XC", "D", 30)],
      [broker("YP", "D", 30)],
      run(1)
    ),
    piece(
      sweep("50", "10:23:20", "buy"),
      [broker("AK", "F", 30)],
      [broker("YP", "D", 30)]
    ),
  ])
  expect(cells("30")).toEqual({ buyer: "YP [D]", seller: "XL [D] ×22" })
  expect(cells("40")).toEqual({ buyer: "XC [D]", seller: "YP [D]" })
  expect(cells("50")).toEqual({ buyer: "AK [F]", seller: "YP [D]" })
})
