// The dashboard's D1 helpers: json_each insert chunks and row decoding. The
// batch itself and its statement types live in @workspace/server/d1.
import type { SqlValue } from "@workspace/server/d1"
import { Effect, Schema } from "effect"

export {
  d1Batch,
  type D1Batch,
  type D1Binding,
  type SqlValue,
  type Statement,
} from "@workspace/server/d1"

// The most rows, and bytes of JSON, one `INSERT … SELECT` over `json_each`
// takes.
// Decision: D1 inserts go in json_each chunks under D1's statement limits
// (apps/dashboard/docs/adr/0018-d1-inserts-go-in-json-each-chunks-under-statement-limits.md)
const CHUNK_ROWS = 1000
const CHUNK_BYTES = 90_000

const encoder = new TextEncoder()

// Gathers rows, each an array of its columns, into JSON arrays of at most
// CHUNK_ROWS rows and CHUNK_BYTES bytes, each chunk turned into text as soon
// as it is full.
export const jsonChunker = () =>
  Effect.sync(() => {
    const chunks: Array<string> = []
    let rows: Array<string> = []
    // The bytes of `rows` as one JSON array.
    let bytes = 2
    return {
      add: (row: ReadonlyArray<SqlValue>) =>
        Effect.sync(() => {
          const json = JSON.stringify(row)
          const rowBytes = encoder.encode(json).length + 1
          const full =
            rows.length === CHUNK_ROWS || bytes + rowBytes > CHUNK_BYTES
          if (full && rows.length > 0) {
            chunks.push(`[${rows.join(",")}]`)
            rows = []
            bytes = 2
          }
          rows.push(json)
          bytes += rowBytes
        }),
      // The chunks of the rows added so far.
      chunks: Effect.sync(() =>
        rows.length === 0 ? chunks : [...chunks, `[${rows.join(",")}]`]
      ),
    }
  })

// `rows` as jsonChunker's chunks, for code that holds its rows already.
export const jsonChunks = Effect.fnUntraced(function* (
  rows: ReadonlyArray<ReadonlyArray<SqlValue>>
) {
  const chunker = yield* jsonChunker()
  for (const row of rows) yield* chunker.add(row)
  return yield* chunker.chunks
})

// Decodes a statement's rows as `row`s. Rows that don't fit are a defect:
// the statement chose their columns.
export const decodeRows = <A, I>(row: Schema.Codec<A, I>) => {
  const decode = Schema.decodeUnknownEffect(Schema.Array(row))
  return (rows: ReadonlyArray<Record<string, unknown>>) =>
    decode(rows).pipe(Effect.orDie)
}
