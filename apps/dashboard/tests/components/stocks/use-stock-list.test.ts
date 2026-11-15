// The stock pickers' list: the stocks with parsed holdings, and a visitor
// whose session ended sent to sign in again.
import { assert, describe, it } from "@effect/vitest"
import { redirect } from "@tanstack/react-router"
import { StockCode } from "@workspace/relay"
import { Effect } from "effect"
import { beforeEach, vi } from "vitest"

import { loadStockList } from "@/components/stocks/use-stock-list"

const mocks = vi.hoisted(() => ({
  stockListFn: vi.fn<() => Promise<unknown>>(),
  signedInAgain: 0,
}))

vi.mock("@/server/stocks/stocks.functions", () => ({
  stockListFn: () => mocks.stockListFn(),
}))
vi.mock("@/components/market-live/sign-in-again", () => ({
  signInAgain: Effect.sync(() => {
    mocks.signedInAgain += 1
  }),
}))

beforeEach(() => {
  mocks.signedInAgain = 0
})

describe("the stock pickers' list", () => {
  it.effect("lists each stock, a KSEI-only one with no name", () =>
    Effect.gen(function* () {
      mocks.stockListFn.mockResolvedValue([
        { code: "APOL", issuerName: undefined },
        { code: "BBCA", issuerName: "BANK CENTRAL ASIA Tbk" },
      ])
      assert.deepStrictEqual(yield* loadStockList("/stocks/BBCA"), {
        _tag: "Ready",
        codes: [
          { code: StockCode.make("APOL"), name: "", kind: "share" },
          {
            code: StockCode.make("BBCA"),
            name: "BANK CENTRAL ASIA Tbk",
            kind: "share",
          },
        ],
      })
    })
  )

  it.effect("sends a visitor whose session ended to sign in again", () =>
    Effect.gen(function* () {
      mocks.stockListFn.mockRejectedValue(
        redirect({ href: "/sign-in?redirect=%2Fstocks%2FBBCA" })
      )
      const list = yield* loadStockList("/stocks/BBCA")
      assert.strictEqual(mocks.signedInAgain, 1)
      assert.strictEqual(list._tag, "Loading")
    })
  )
})
