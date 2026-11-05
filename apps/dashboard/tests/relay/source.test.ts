import { describe, expect, test } from "vitest"

import { OWN_SESSION, ingestIsSilent, selectSource } from "@/relay/source"

const ingest = (
  id: string,
  connectedAt: number,
  datafeed = true,
  install: string | null = null
) => ({ id, connectedAt, datafeed, install })

describe("selectSource", () => {
  test("nothing active and nothing connected is no source", () => {
    expect(selectSource(null, [])).toBeNull()
  })

  test("an open ingest without a datafeed is not a source", () => {
    expect(selectSource(null, [ingest("a", 1, false)])).toBeNull()
  })

  test("an ingest with a datafeed takes the role when nothing is active", () => {
    expect(selectSource(null, [ingest("a", 1)])).toBe("a")
  })

  test("a new ingest stays paused while the active one has a datafeed", () => {
    expect(selectSource("a", [ingest("a", 2), ingest("b", 1)])).toBe("a")
  })

  test("an ingest with no datafeed loses the role to the oldest that has one", () => {
    expect(
      selectSource("a", [
        ingest("a", 1, false),
        ingest("c", 3),
        ingest("b", 2),
        ingest("d", 0, false),
      ])
    ).toBe("b")
  })

  test("the last datafeed going leaves no source", () => {
    expect(selectSource("a", [ingest("a", 1, false)])).toBeNull()
  })

  test("a returning ingest stays paused", () => {
    const lostRole = selectSource("a", [ingest("a", 1, false), ingest("b", 2)])
    expect(selectSource(lostRole, [ingest("a", 1), ingest("b", 2)])).toBe("b")
  })

  test("a stored id with no open socket does not count", () => {
    expect(selectSource("gone", [])).toBeNull()
    expect(selectSource("gone", [ingest("b", 2)])).toBe("b")
  })
})

describe("selectSource with the extension's install", () => {
  test("a newer ingest from the active ingest's install takes the role at once", () => {
    expect(
      selectSource("a", [ingest("a", 1, true, "x"), ingest("b", 2, true, "x")])
    ).toBe("b")
  })

  test("of several from the active ingest's install, the newest takes it", () => {
    expect(
      selectSource("a", [
        ingest("c", 3, true, "x"),
        ingest("a", 1, true, "x"),
        ingest("b", 2, true, "x"),
      ])
    ).toBe("c")
  })

  test("an older ingest from the active ingest's install does not take it back", () => {
    expect(
      selectSource("b", [ingest("a", 1, true, "x"), ingest("b", 2, true, "x")])
    ).toBe("b")
  })

  test("one from the active ingest's install with no datafeed waits", () => {
    expect(
      selectSource("a", [ingest("a", 1, true, "x"), ingest("b", 2, false, "x")])
    ).toBe("a")
  })

  test("one from another install waits for the active ingest", () => {
    expect(
      selectSource("a", [ingest("a", 1, true, "x"), ingest("b", 2, true, "y")])
    ).toBe("a")
  })

  test("one with no install waits for the active ingest", () => {
    expect(
      selectSource("a", [ingest("a", 1, true, "x"), ingest("b", 2, true, null)])
    ).toBe("a")
  })

  test("an active ingest with no install keeps the role over another with none", () => {
    expect(
      selectSource("a", [
        ingest("a", 1, true, null),
        ingest("b", 2, true, null),
      ])
    ).toBe("a")
  })

  test("the own session still holds the role over the active ingest's install", () => {
    expect(
      selectSource(
        OWN_SESSION,
        [ingest("a", 1, true, "x"), ingest("b", 2, true, "x")],
        true
      )
    ).toBe(OWN_SESSION)
  })
})

describe("ingestIsSilent", () => {
  const CONNECTED = 1_000_000

  test("the last ping within 45 s keeps it", () => {
    expect(
      ingestIsSilent(CONNECTED + 100_000, CONNECTED + 55_000, CONNECTED)
    ).toBe(false)
  })

  test("a ping over 45 s ago closes it", () => {
    expect(
      ingestIsSilent(CONNECTED + 100_001, CONNECTED + 55_000, CONNECTED)
    ).toBe(true)
  })

  test("with no ping yet, the time counts from the connect", () => {
    expect(ingestIsSilent(CONNECTED + 45_000, null, CONNECTED)).toBe(false)
    expect(ingestIsSilent(CONNECTED + 45_001, null, CONNECTED)).toBe(true)
  })

  test("a ping from an earlier socket's timestamp does not outlive the connect", () => {
    expect(
      ingestIsSilent(CONNECTED + 1000, CONNECTED - 90_000, CONNECTED)
    ).toBe(false)
  })
})

describe("selectSource with the own session", () => {
  test("while live it holds the role, and every ingest is paused", () => {
    expect(selectSource("a", [ingest("a", 1)], true)).toBe(OWN_SESSION)
    expect(selectSource(null, [], true)).toBe(OWN_SESSION)
  })

  test("leaving live hands over to the oldest ingest with a datafeed", () => {
    expect(
      selectSource(
        OWN_SESSION,
        [ingest("c", 3), ingest("b", 2), ingest("a", 1, false)],
        false
      )
    ).toBe("b")
  })

  test("leaving live with no datafeed leaves no source", () => {
    expect(selectSource(OWN_SESSION, [ingest("a", 1, false)], false)).toBeNull()
  })

  test("returning to live takes the role back", () => {
    const handed = selectSource(OWN_SESSION, [ingest("a", 1)], false)
    expect(handed).toBe("a")
    expect(selectSource(handed, [ingest("a", 1)], true)).toBe(OWN_SESSION)
  })
})
