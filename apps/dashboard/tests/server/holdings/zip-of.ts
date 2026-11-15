import { Effect } from "effect"

const deflated = (bytes: Uint8Array<ArrayBuffer>) =>
  Effect.promise(() =>
    new Response(
      new Blob([bytes])
        .stream()
        .pipeThrough(new CompressionStream("deflate-raw"))
    ).bytes()
  )

// A zip of each `[name, bytes]` entry, deflated, in order. A name given as
// bytes is written as is.
export const zipOf = Effect.fnUntraced(function* (
  files: ReadonlyArray<readonly [string | Uint8Array, Uint8Array<ArrayBuffer>]>
) {
  const locals: Array<Uint8Array> = []
  const centrals: Array<Uint8Array> = []
  let offset = 0
  for (const [fileName, bytes] of files) {
    const data = yield* deflated(bytes)
    const name =
      typeof fileName === "string"
        ? new TextEncoder().encode(fileName)
        : fileName
    const local = new Uint8Array(30 + name.length + data.length)
    const localView = new DataView(local.buffer)
    localView.setUint32(0, 0x04034b50, true)
    localView.setUint16(8, 8, true)
    localView.setUint32(18, data.length, true)
    localView.setUint32(22, bytes.length, true)
    localView.setUint16(26, name.length, true)
    local.set(name, 30)
    local.set(data, 30 + name.length)
    const central = new Uint8Array(46 + name.length)
    const centralView = new DataView(central.buffer)
    centralView.setUint32(0, 0x02014b50, true)
    centralView.setUint16(10, 8, true)
    centralView.setUint32(20, data.length, true)
    centralView.setUint32(24, bytes.length, true)
    centralView.setUint16(28, name.length, true)
    centralView.setUint32(42, offset, true)
    central.set(name, 46)
    locals.push(local)
    centrals.push(central)
    offset += local.length
  }
  const centralLength = centrals.reduce((sum, part) => sum + part.length, 0)
  const end = new Uint8Array(22)
  const endView = new DataView(end.buffer)
  endView.setUint32(0, 0x06054b50, true)
  endView.setUint16(8, files.length, true)
  endView.setUint16(10, files.length, true)
  endView.setUint32(12, centralLength, true)
  endView.setUint32(16, offset, true)
  const zip = new Uint8Array(offset + centralLength + end.length)
  let at = 0
  for (const part of [...locals, ...centrals, end]) {
    zip.set(part, at)
    at += part.length
  }
  return zip
})
