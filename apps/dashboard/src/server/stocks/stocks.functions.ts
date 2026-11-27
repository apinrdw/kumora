import { createServerFn } from "@tanstack/react-start"
import { getRequest } from "@tanstack/react-start/server"
import { runServerEffect } from "@workspace/server"
import { WibDate } from "@workspace/relay"
import { Effect, Layer, Schema } from "effect"

import { HolderMapQuery, MovesSelection } from "@/domain/holdings"
import { RANGE_PRESETS } from "@/lib/broker-inventory"
import { safeRedirect } from "@/lib/redirect"
import { Auth } from "@/server/auth/auth"
import { brokerTotalsDbD1 } from "@/server/broker-totals/db"
import { holdingsDbD1 } from "@/server/holdings/db"

import {
  brokerInventoryView,
  holderMapPageView,
  holderMapStocksView,
  holderMovesPageView,
  stockListView,
  stockPageView,
} from "./stocks.ts"

const services = Layer.mergeAll(Auth.layer, holdingsDbD1, brokerTotalsDbD1)

const decodeStockPage = Schema.decodeUnknownSync(
  Schema.Struct({
    code: Schema.String,
    month: Schema.optional(Schema.String),
  })
)

// /stocks/$CODE's loader.
export const stockPageFn = createServerFn({ method: "GET" })
  .validator(decodeStockPage)
  .handler(({ data }) =>
    runServerEffect(
      stockPageView(getRequest().headers, data.code, data.month).pipe(
        Effect.provide(services)
      )
    )
  )

const decodeBrokerInventory = Schema.decodeUnknownSync(
  Schema.Struct({
    code: Schema.String,
    window: Schema.Union([
      Schema.Struct({ range: Schema.Literals(RANGE_PRESETS) }),
      Schema.Struct({ from: WibDate, to: WibDate }),
    ]),
  })
)

// The Broker inventory tab's read, in /stocks/$CODE's loader.
export const brokerInventoryFn = createServerFn({ method: "GET" })
  .validator(decodeBrokerInventory)
  .handler(({ data }) =>
    runServerEffect(
      brokerInventoryView(getRequest().headers, data.code, data.window).pipe(
        Effect.provide(services)
      )
    )
  )

// The stock picker's list; `data` is the page the visitor returns to after
// signing in again.
export const stockListFn = createServerFn({ method: "GET" })
  .validator((href: unknown) => Effect.runSync(safeRedirect(href)))
  .handler(({ data }) =>
    runServerEffect(
      stockListView(getRequest().headers, data).pipe(Effect.provide(services))
    )
  )

const decodeHolderMap = Schema.decodeUnknownSync(HolderMapQuery)

// /holder-map's loader.
export const holderMapFn = createServerFn({ method: "GET" })
  .validator(decodeHolderMap)
  .handler(({ data }) =>
    runServerEffect(
      holderMapPageView(getRequest().headers, data).pipe(
        Effect.provide(services)
      )
    )
  )

// The Holder map search's stocks; `data` is the page the visitor returns to
// after signing in again.
export const holderMapStocksFn = createServerFn({ method: "GET" })
  .validator((href: unknown) => Effect.runSync(safeRedirect(href)))
  .handler(({ data }) =>
    runServerEffect(
      holderMapStocksView(getRequest().headers, data).pipe(
        Effect.provide(services)
      )
    )
  )

const decodeHolderMoves = Schema.decodeUnknownSync(MovesSelection)

// /holder-moves' loader.
export const holderMovesFn = createServerFn({ method: "GET" })
  .validator(decodeHolderMoves)
  .handler(({ data }) =>
    runServerEffect(
      holderMovesPageView(getRequest().headers, data).pipe(
        Effect.provide(services)
      )
    )
  )
