// The broker code of an above-5% account's custodian (spec apinrdw/kumora#673,
// "Broker codes"): the exchange member it names, or the closed member whose
// KSEI holding account it is; none for a bank or other custodian.
//
// Decision: broker codes come from a checked-in table of IDX's member list,
// looked up on read (apps/dashboard/docs/adr/0132-broker-codes-are-looked-up-on-read.md)
import { BrokerCode } from "@workspace/relay"
import { Effect } from "effect"

import { EXCHANGE_MEMBERS } from "@/lib/exchange-members"

const LEGAL_FORMS = new Set(["PT", "TBK", "PERSERO"])

// Uppercase, punctuation and legal forms dropped: `PANIN SEKURITAS Tbk, PT`
// reads as IDX's `PANIN SEKURITAS`.
const normalized = (name: string) =>
  Effect.sync(() =>
    name
      .toUpperCase()
      .split(/[^A-Z0-9]+/)
      .filter((word) => word !== "" && !LEGAL_FORMS.has(word))
      .join(" ")
  )

const MEMBERS = new Map(
  Effect.runSync(
    Effect.forEach(EXCHANGE_MEMBERS, ([code, name]) =>
      Effect.map(normalized(name), (key) => [key, code] as const)
    )
  )
)

// KSEI's holding account for a closed member names its code with a serial:
// `CLOSED MEMBER-SM001`, `CLOSED MEMBER -IP001`, `TAMP QA001`,
// `TAMPUNGAN MK001`.
const CLOSED_MEMBER =
  /(?:CLOSED MEMBER\s*-\s*|TAMP(?:UNGAN)?\s+)([A-Z]{2})\d{3}/

export const brokerOf = Effect.fnUntraced(function* (
  custodian: string
): Effect.fn.Return<BrokerCode | undefined> {
  const closed = CLOSED_MEMBER.exec(custodian.toUpperCase())?.[1]
  return closed === undefined
    ? MEMBERS.get(yield* normalized(custodian))
    : BrokerCode.make(closed)
})
