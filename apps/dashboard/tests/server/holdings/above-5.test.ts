import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"

import { MAX_SHARED_STRINGS_BYTES } from "@/server/holdings/xlsx"
import { MAX_ENTRY_BYTES } from "@/server/holdings/zip"

import { bytesOf } from "./at-cap.ts"
import { PARSE_HEAP_MIB, parseInBoundedHeap } from "./bounded-heap.ts"
import {
  columnLetters,
  SHARED_STRINGS,
  SHEET,
  sharedItems,
} from "./workbook.ts"
import { zipOf } from "./zip-of.ts"

const inline = (ref: string, text: string) =>
  `<c r="${ref}" t="str"><v>${text}</v></c>`
const shared = (ref: string, index: number) =>
  `<c r="${ref}" t="s"><v>${index}</v></c>`
const number = (ref: string, value: number) =>
  `<c r="${ref}"><v>${value}</v></c>`

// The worker parses its report as of 30 Oct 2026, the day after 29 Oct.
const TITLE = `<row r="1">${inline("A1", "KEPEMILIKAN EFEK DIATAS 5% BERDASARKAN SID (PUBLIK) per tanggal 30 Oct 2026")}</row>`
const LABELS = [
  "No",
  "Kode Efek",
  "Nama Emiten",
  "Nama Pemegang Rekening Efek",
  "Nama Pemegang Saham",
  "Nama Rekening Efek",
  "Alamat",
  "Alamat (Lanjutan)",
  "Kebangsaan",
  "Domisili",
  "Status (Lokal/Asing)",
  "Kepemilikan Per 29-OCT-2026",
  "",
  "",
  "Kepemilikan Per 30-OCT-2026",
  "",
  "",
  "Perubahan",
]
const SUBLABELS = [
  "Jumlah Saham",
  "Saham Gabungan Per Investor",
  "Persentase Kepemilikan Per Investor (%)",
]
const HEADER = `<row r="2">${LABELS.map((label, column) =>
  label === "" ? "" : inline(`${columnLetters(column)}2`, label)
).join("")}</row><row r="3">${[...SUBLABELS, ...SUBLABELS]
  .map((label, index) => inline(`${columnLetters(11 + index)}3`, label))
  .join("")}</row>`
const LEGEND = [
  "Keterangan",
  "* Font:",
  "Hitam = tidak ada perubahan kepemilikan",
  "Biru = Ada perubahan persentase kepemilikan tetapi masih tetap diatas 5% dibandingkan hari sebelumnya",
]
const legend = (from: number) =>
  LEGEND.map(
    (text, index) =>
      `<row r="${from + index}">${inline(`A${from + index}`, text)}</row>`
  ).join("")

// The longest holder name, of 2-letter words so its holder key is as long,
// is shared string 0; the longest other name is 1; the longest other text 2;
// the stock code 3; `1` 4; `5.00` 5; `-` 6; `L` 7.
const STRINGS = [
  "AB ".repeat(85).concat("A"),
  "A".repeat(256),
  "A".repeat(128),
  "AAAA",
  "1",
  "5.00",
  "-",
  "L",
]

// Row `row`: block `no`, one account, with every text at its longest.
const fullRow = (row: number, no: number) =>
  `<row r="${row}">${[
    number(`A${row}`, no),
    shared(`B${row}`, 3),
    shared(`C${row}`, 1),
    shared(`D${row}`, 1),
    shared(`E${row}`, 0),
    shared(`F${row}`, 1),
    shared(`G${row}`, 2),
    shared(`H${row}`, 2),
    shared(`I${row}`, 2),
    shared(`J${row}`, 2),
    shared(`K${row}`, 7),
    shared(`L${row}`, 6),
    shared(`M${row}`, 6),
    shared(`N${row}`, 6),
    shared(`O${row}`, 4),
    shared(`P${row}`, 4),
    shared(`Q${row}`, 5),
    shared(`R${row}`, 6),
  ].join("")}</row>`

// Row `row`: an account of the block above, in the fewest cells one takes.
const shortRow = (row: number) =>
  `<row r="${row}">${[
    shared(`B${row}`, 3),
    shared(`D${row}`, 4),
    shared(`F${row}`, 4),
    shared(`K${row}`, 7),
    shared(`L${row}`, 6),
    number(`O${row}`, 0),
    shared(`R${row}`, 6),
  ].join("")}</row>`

const SHEET_HEAD = "<worksheet><sheetData>"
const SHEET_TAIL = "</sheetData></worksheet>"

// The largest sheet: the title and header rows, then `rows` rows, or as many
// as fit beside the legend, then the legend.
const largestSheet = (
  rows: number,
  dataRow: (row: number, index: number) => string
) => {
  const parts = [TITLE, HEADER]
  const tail = legend(99_999) + SHEET_TAIL
  let size = SHEET_HEAD.length + TITLE.length + HEADER.length + tail.length
  let row = 4
  for (let index = 0; index < rows; index++, row++) {
    const xml = dataRow(row, index)
    if (size + xml.length > MAX_ENTRY_BYTES) break
    parts.push(xml)
    size += xml.length
  }
  return bytesOf(SHEET_HEAD, parts.join(""), legend(row), SHEET_TAIL)
}

// STRINGS, then distinct strings until the shared strings reach their cap.
const paddedStrings = () => {
  const strings = [...STRINGS]
  const entryBytes = (string: string) => `<si><t>${string}</t></si>`.length
  let size =
    "<sst></sst>".length + STRINGS.map(entryBytes).reduce((a, b) => a + b)
  for (
    let index = 0;
    size + entryBytes(`S${index}`) <= MAX_SHARED_STRINGS_BYTES;
    index++
  ) {
    strings.push(`S${index}`)
    size += entryBytes(`S${index}`)
  }
  return bytesOf(`<sst>${sharedItems(strings)}</sst>`)
}

const SHAPES: ReadonlyArray<{
  readonly shape: string
  readonly rows: number
  readonly dataRow: (row: number, index: number) => string
  readonly posts: string
}> = [
  {
    shape: "more rows than a day can list",
    rows: Number.POSITIVE_INFINITY,
    dataRow: (row, index) => (index === 0 ? fullRow(row, 1) : shortRow(row)),
    posts: "The report lists more than 8,000 rows",
  },
  {
    shape:
      "the most rows a day can list, each a holder of one account with its every text at its longest, padded with shared strings",
    rows: 8_000,
    dataRow: (row, index) => fullRow(row, index + 1),
    posts: "Parsed 1 stocks",
  },
]

describe(`the largest above-5% report, parsed in ${PARSE_HEAP_MIB} MiB of heap`, () => {
  for (const { shape, rows, dataRow, posts } of SHAPES)
    it.effect(
      shape,
      () =>
        Effect.gen(function* () {
          const report = yield* zipOf([
            [SHARED_STRINGS, paddedStrings()],
            [SHEET, largestSheet(rows, dataRow)],
          ])
          assert.strictEqual(
            yield* parseInBoundedHeap("above-5", report),
            posts
          )
        }),
      { timeout: 30_000 }
    )
})
