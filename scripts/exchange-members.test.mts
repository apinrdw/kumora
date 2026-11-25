import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"

import { membersModule } from "./exchange-members.mts"

const member = (Code: string, Name: string) => ({
  Code,
  Name,
  License: "Perantara Pedagang Efek",
})

describe("membersModule", () => {
  it.effect("writes every listed member's code and name, by code", () =>
    Effect.gen(function* () {
      const module = yield* membersModule({
        recordsTotal: 2,
        data: [
          member("YU", "CGS INTERNATIONAL SEKURITAS INDONESIA"),
          member("PD", "INDO PREMIER SEKURITAS"),
        ],
      })
      assert.include(
        module,
        [
          '  ["PD", "INDO PREMIER SEKURITAS"],',
          '  ["YU", "CGS INTERNATIONAL SEKURITAS INDONESIA"],',
        ].join("\n")
      )
    })
  )

  it.effect("fails when IDX lists more members than it sent", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        membersModule({
          recordsTotal: 88,
          data: [member("PD", "INDO PREMIER SEKURITAS")],
        })
      )
      assert.include(error.message, "88 members but sent 1")
    })
  )
})
