import { MAX_DIRECTORY_BYTES, MAX_ENTRY_BYTES } from "@/server/holdings/zip"

// A part's text, its bytes, or a byte written as is, such as 0xff, which no
// UTF-8 text holds and which decodes as U+FFFD, a two-byte character.
type Part = string | Uint8Array | number

// `parts` as bytes, in order.
export const bytesOf = (...parts: ReadonlyArray<Part>) => {
  const encoded = parts.map((part) =>
    typeof part === "number"
      ? Uint8Array.of(part)
      : typeof part === "string"
        ? new TextEncoder().encode(part)
        : part
  )
  const bytes = new Uint8Array(
    encoded.reduce((sum, part) => sum + part.length, 0)
  )
  let at = 0
  for (const part of encoded) {
    bytes.set(part, at)
    at += part.length
  }
  return bytes
}

// `head`, then `unit` as many times as fit in `cap` bytes, the largest zip
// entry unless given, then `tail`.
export const atCap = (
  head: Part,
  unit: Part,
  tail: Part,
  cap = MAX_ENTRY_BYTES
) => {
  const [headBytes, unitBytes, tailBytes] = [head, unit, tail].map((part) =>
    bytesOf(part)
  ) as [Uint8Array, Uint8Array, Uint8Array]
  const times = Math.floor(
    (cap - headBytes.length - tailBytes.length) / unitBytes.length
  )
  const bytes = new Uint8Array(
    headBytes.length + times * unitBytes.length + tailBytes.length
  )
  bytes.set(headBytes)
  if (unitBytes.length === 1)
    bytes.fill(unitBytes[0] ?? 0, headBytes.length, bytes.length)
  else
    for (let time = 0; time < times; time++)
      bytes.set(unitBytes, headBytes.length + time * unitBytes.length)
  bytes.set(tailBytes, bytes.length - tailBytes.length)
  return bytes
}

const LONGEST_NAME = 0xffff

// A directory entry's bytes besides its name.
const ENTRY_BYTES = 46

// Empty files under the shortest distinct names, as many as fit, the last
// name padded, so that beside files named `names` a zip's directory takes
// exactly MAX_DIRECTORY_BYTES.
export const filesToDirectoryCap = (names: ReadonlyArray<string>) => {
  let left =
    MAX_DIRECTORY_BYTES -
    names.reduce((sum, name) => sum + ENTRY_BYTES + bytesOf(name).length, 0)
  const files: Array<readonly [string, Uint8Array<ArrayBuffer>]> = []
  for (let index = 0; left > 0; index++) {
    let name = String(index)
    if (
      left - ENTRY_BYTES - name.length <
      ENTRY_BYTES + String(index + 1).length
    )
      name = name.padEnd(left - ENTRY_BYTES, "_")
    files.push([name, new Uint8Array(0)])
    left -= ENTRY_BYTES + name.length
  }
  return files
}

// Empty files under distinct names of the longest length a zip entry holds,
// 0xff bytes after an index, as many as a zip of `zipBytes` holds besides
// its other files.
export const longNamedFiles = (zipBytes: number) =>
  Array.from(
    // Each name is written twice, in its local header and its directory entry.
    { length: Math.floor(zipBytes / (30 + 46 + 2 * LONGEST_NAME + 2)) - 1 },
    (_, index) => {
      const name = new Uint8Array(LONGEST_NAME).fill(0xff)
      name.set(new TextEncoder().encode(String(index)))
      return [name, new Uint8Array(0)] as const
    }
  )
