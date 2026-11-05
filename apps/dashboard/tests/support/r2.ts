type TestBucket = R2Bucket & {
  keys: () => Array<string>
  /** Holds each `put` until this many arrive, so concurrent requests have all passed their checks. */
  holdPutsUntil: (count: number) => void
}

/** The part of `R2Bucket` the ownership store calls, in memory. */
export const r2Bucket = (): TestBucket => {
  const objects = new Map<string, Uint8Array>()
  let held: Array<() => void> = []
  let holdFor = 0
  return {
    keys: () => [...objects.keys()],
    holdPutsUntil: (count: number) => {
      holdFor = count
    },
    put: async (key: string, value: ArrayBuffer | string) => {
      if (holdFor > 0) {
        await new Promise<void>((release) => {
          held.push(release)
          if (held.length < holdFor) return
          holdFor = 0
          for (const next of held) next()
          held = []
        })
      }
      objects.set(
        key,
        typeof value === "string"
          ? new TextEncoder().encode(value)
          : new Uint8Array(value)
      )
    },
    delete: async (key: string) => {
      objects.delete(key)
    },
    get: async (key: string) => {
      const bytes = objects.get(key)
      return bytes === undefined
        ? null
        : { text: async () => new TextDecoder().decode(bytes) }
    },
  } as unknown as TestBucket
}
