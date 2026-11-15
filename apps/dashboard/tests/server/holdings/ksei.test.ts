import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"

import { MAX_KSEI_REPORT_BYTES } from "@/server/ksei/archive-run"
import { MAX_ENTRY_BYTES } from "@/server/holdings/zip"

import { atCap, longNamedFiles } from "./at-cap.ts"
import { PARSE_HEAP_MIB, parseInBoundedHeap } from "./bounded-heap.ts"
import { zipOf } from "./zip-of.ts"

const TYPES = ["IS", "CP", "PF", "IB", "ID", "MF", "SC", "FD", "OT"]

const HEADER = [
  "Date|Code|Type|Sec. Num|Price",
  ...TYPES.map((type) => `Local ${type}`),
  "Total",
  ...TYPES.map((type) => `Foreign ${type}`),
  "Total",
].join("|")

const NAME = "Balancepos20261030.txt"

// Stock `code`'s line: listed 1 share at 1, holding a share of every type.
const stockLine = (code: string) =>
  `30-Oct-2026|${code}|EQUITY|1|1|${"1|".repeat(9)}9|${"1|".repeat(9)}9`

// A line of a security that isn't a stock.
const BOND_LINE = `30-Oct-2026|B|CORPORATE BOND|1|1|${"0|".repeat(9)}0|${"0|".repeat(9)}0`

// The header, then `stocks` stock lines, then as many of `line`'s lines as
// fit in the largest file.
const largestFile = (line: (number: number) => string, stocks = 0) => {
  const lines = [HEADER]
  let size = HEADER.length
  let number = 2
  for (; number < stocks + 2; number++) {
    lines.push(stockLine(`S${number}`))
    size += 1 + stockLine(`S${number}`).length
  }
  for (; size + 1 + line(number).length <= MAX_ENTRY_BYTES; number++) {
    lines.push(line(number))
    size += 1 + line(number).length
  }
  return zipOf([[NAME, new TextEncoder().encode(lines.join("\n"))]])
}

// Each shape at the largest a zip entry inflates to, and what parsing it
// in PARSE_HEAP_MIB posts.
const SHAPES: ReadonlyArray<{
  readonly shape: string
  readonly report: () => Effect.Effect<Uint8Array>
  readonly posts: string
}> = [
  {
    shape: "two-letter lines",
    report: () => largestFile(() => "ab"),
    posts: "Line 2 has 1 fields",
  },
  {
    shape: "more stocks than a month can list",
    report: () => largestFile((number) => stockLine(`S${number}`)),
    posts: "The report lists more than 2,000 stocks",
  },
  {
    shape:
      "the most stocks a month can list, each holding every type, padded with lines of other securities",
    report: () => largestFile(() => BOND_LINE, 2_000),
    posts: "Parsed 2000 stocks",
  },
  {
    shape: "empty lines",
    report: () => zipOf([[NAME, atCap(HEADER, "\n", "")]]),
    posts: "The file has no EQUITY rows",
  },
  {
    shape: "one line of separators",
    report: () => zipOf([[NAME, atCap(`${HEADER}\n`, "|", "")]]),
    posts: "Line 2 has more than 25 fields",
  },
  {
    shape: "one stock line whose code is two-byte characters",
    report: () =>
      zipOf([
        [
          NAME,
          atCap(
            `${HEADER}\n30-Oct-2026|`,
            0xff,
            stockLine("").slice("30-Oct-2026|".length)
          ),
        ],
      ]),
    posts: `Line 2's Code is over 16 characters: ${String.fromCodePoint(0xfffd).repeat(40)}…`,
  },
  {
    shape: "one header line of two-byte characters",
    report: () => zipOf([[NAME, atCap(HEADER, 0xff, "")]]),
    posts: `The header isn't the known one: ${HEADER.slice(0, 40)}…`,
  },
  {
    shape:
      "a zip of as many files under the longest names as KSEI's file holds",
    report: () =>
      zipOf([
        [NAME, new TextEncoder().encode(`${HEADER}\n${stockLine("BBCA")}`)],
        ...longNamedFiles(MAX_KSEI_REPORT_BYTES),
      ]),
    posts: "The zip's directory is over 65,536 bytes",
  },
]

describe(`the largest Securities holdings report, parsed in ${PARSE_HEAP_MIB} MiB of heap`, () => {
  for (const { shape, report, posts } of SHAPES)
    it.effect(
      shape,
      () =>
        Effect.gen(function* () {
          assert.strictEqual(
            yield* parseInBoundedHeap("ksei", yield* report()),
            posts
          )
        }),
      { timeout: 30_000 }
    )
})
