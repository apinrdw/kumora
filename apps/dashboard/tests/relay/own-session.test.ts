import { Symbol } from "@/domain/symbol"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { UNAUTHORIZED_UPGRADE, OwnSession } from "@/relay/own-session"
import type {
  StoredCredential,
  OwnSessionSocket,
  OwnSessionStore,
} from "@/relay/own-session"
import {
  DISABLED,
  encodeAuth,
  encodeChannel,
  encodePing,
} from "@/relay/upstream"
import type { OwnSessionMachine } from "@/relay/upstream"
import type { WrapFrame } from "@/relay/stockbit"

const NOW = Date.parse("2026-10-29T03:00:00Z")
const HOUR_S = 3600

const b64url = (text: string) =>
  btoa(text).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")
const jwt = (exp: number, id = "a") =>
  `${b64url('{"alg":"RS256"}')}.${b64url(JSON.stringify({ exp, id }))}.secret-signature`
const TOKEN = jwt(NOW / 1000 + HOUR_S)
const KEY = "websocket-key-must-stay-out-of-logs"

const str = (no: number, text: string) => {
  const bytes = new TextEncoder().encode(text)
  const length =
    bytes.length < 128
      ? [bytes.length]
      : [(bytes.length % 128) | 0x80, bytes.length >> 7]
  return [no * 8 + 2, ...length, ...bytes]
}
const frame = (token = TOKEN, key = KEY) =>
  btoa(String.fromCharCode(...str(1, "42"), ...str(3, key), ...str(5, token)))
const PAIR = { userId: "42", key: KEY, token: TOKEN }

const PONG = new Uint8Array([0x12, 0x06, 0x0a, 0x04, 0x70, 0x6f, 0x6e, 0x67])
const ERROR_401 = new Uint8Array([7 * 8 + 2, 3, 0x08, 0x91, 0x03])
const ERROR_500 = new Uint8Array([7 * 8 + 2, 3, 0x08, 0xf4, 0x03])
/** An empty `running_trade_batch`. */
const TAPE = new Uint8Array([0x42, 0x00])
/** A `liveprice` for BBCA, with no figures. */
const LIVEPRICE = new Uint8Array([
  0x4a, 0x06, 0x0a, 0x04, 0x42, 0x42, 0x43, 0x41,
])

class FakeSocket implements OwnSessionSocket {
  sent: Array<Uint8Array> = []
  closed = false
  private listeners = new Map<string, (e: { data: unknown }) => void>()
  send(bytes: Uint8Array) {
    this.sent.push(bytes)
  }
  close() {
    this.closed = true
  }
  addEventListener(type: string, listener: (e: { data: unknown }) => void) {
    this.listeners.set(type, listener)
  }
  receive(bytes: Uint8Array) {
    this.listeners.get("message")?.({
      data: bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.length
      ),
    })
  }
  serverClose() {
    this.listeners.get("close")?.({ data: null })
  }
}

const memoryStore = (
  seed: {
    machine?: OwnSessionMachine
    credential?: StoredCredential
  } = {}
) => {
  const data = {
    machine: seed.machine ?? null,
    credential: seed.credential ?? null,
  }
  const store: OwnSessionStore = {
    machine: () => data.machine,
    saveMachine: (m) => {
      data.machine = m
    },
    credential: () => data.credential,
    saveCredential: (c) => {
      data.credential = c
    },
    rejectCredential: () => {
      if (data.credential)
        data.credential = { ...data.credential, rejected: true }
    },
    forgetCredential: () => {
      data.credential = null
    },
  }
  return { data, store }
}

const setup = (
  seed?: Parameters<typeof memoryStore>[0],
  overrides: {
    open?: () => boolean
    connect?: () => Promise<OwnSessionSocket>
  } = {}
) => {
  const { data, store } = memoryStore(seed)
  const sockets: Array<FakeSocket> = []
  const calls = {
    asks: 0,
    oks: 0,
    stops: 0,
    changes: 0,
    frames: [] as Array<WrapFrame>,
    logs: [] as Array<string>,
  }
  const session = new OwnSession({
    store,
    now: () => Date.now(),
    open: overrides.open ?? (() => true),
    symbols: () => [Symbol.make("BBCA")],
    connect:
      overrides.connect ??
      (() => {
        const socket = new FakeSocket()
        sockets.push(socket)
        return Promise.resolve(socket)
      }),
    askCredential: () => calls.asks++,
    credentialOk: () => calls.oks++,
    credentialStop: () => calls.stops++,
    onFrame: (bytes) => calls.frames.push(bytes),
    onChange: () => calls.changes++,
    log: (event, fields) =>
      calls.logs.push(JSON.stringify({ event, ...fields })),
  })
  session.restart()
  return { session, sockets, calls, data }
}

/** Lets the connect's promise settle without moving the clock. */
const settled = () => vi.advanceTimersByTimeAsync(0)

const liveSession = async () => {
  const context = setup()
  context.session.setEnabled(true)
  context.session.offerCredential(frame())
  await settled()
  context.sockets[0]?.receive(TAPE)
  expect(context.session.machine.state).toBe("live")
  return context
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})
afterEach(() => {
  vi.useRealTimers()
})

describe("with the switch off", () => {
  test("a new object reads disabled, and asks for nothing", () => {
    const { session, calls, data } = setup()
    expect(session.machine).toEqual(DISABLED)
    expect(session.enabled).toBe(false)
    expect(session.needsCredential).toBe(false)
    expect(session.credentialExpiresAt).toBeNull()
    expect(calls.asks).toBe(0)
    expect(data.credential).toBeNull()
  })

  test("an unasked credential is not stored", async () => {
    const { session, sockets, calls, data } = setup()
    session.offerCredential(frame())
    session.tick()
    await settled()
    expect(data.credential).toBeNull()
    expect(calls.oks).toBe(0)
    expect(sockets).toEqual([])
  })

  test("turning it off forgets the pair and closes the socket", async () => {
    const { session, sockets, data } = await liveSession()
    session.setEnabled(false)
    expect(data.credential).toBeNull()
    expect(sockets[0]?.closed).toBe(true)
    expect(session.machine).toEqual(DISABLED)
    expect(session.live).toBe(false)
  })

  test("turning it off tells the extension to stop sending frames", async () => {
    const { session, calls } = await liveSession()
    expect(calls.stops).toBe(0)
    session.setEnabled(false)
    expect(calls.stops).toBe(1)
  })

  test("turning it off while it waits for a credential tells it too", () => {
    const { session, calls } = setup()
    session.setEnabled(true)
    expect(calls.asks).toBe(1)
    session.setEnabled(false)
    expect(calls.stops).toBe(1)
  })

  test("a switch already off says nothing", () => {
    const { session, calls } = setup()
    session.setEnabled(false)
    expect(calls.stops).toBe(0)
  })

  test("a connect still in flight when it goes off is closed on arrival", async () => {
    const socket = new FakeSocket()
    let arrive: (s: OwnSessionSocket) => void = () => undefined
    const { session } = setup(undefined, {
      connect: () => new Promise((resolve) => (arrive = resolve)),
    })
    session.setEnabled(true)
    session.offerCredential(frame())
    session.setEnabled(false)
    arrive(socket)
    await settled()
    expect(socket.closed).toBe(true)
    expect(socket.sent).toEqual([])
  })
})

describe("the credential", () => {
  test("switching on in hours asks, and a push connects with auth then channel", async () => {
    const { session, sockets, calls, data } = setup()
    session.setEnabled(true)
    expect(session.machine.state).toBe("no-credential")
    expect(calls.asks).toBe(1)
    session.offerCredential(frame())
    expect(calls.oks).toBe(1)
    expect(data.credential?.token).toBe(TOKEN)
    await settled()
    expect(sockets[0]?.sent).toEqual([
      encodeAuth(PAIR),
      encodeChannel(PAIR, [Symbol.make("BBCA")]),
    ])
    expect(session.machine.state).toBe("connecting")
  })

  test("a frame that is not a credential is refused, with no ok", () => {
    const { session, calls, data } = setup()
    session.setEnabled(true)
    session.offerCredential(btoa("nonsense"))
    expect(calls.oks).toBe(0)
    expect(data.credential).toBeNull()
  })

  test("a second push while one is usable only says ok", () => {
    const { session, calls, data } = setup()
    session.setEnabled(true)
    session.offerCredential(frame())
    const stored = data.credential
    session.offerCredential(frame(jwt(NOW / 1000 + 2 * HOUR_S)))
    expect(calls.oks).toBe(2)
    expect(data.credential).toBe(stored)
  })

  test("the status carries the expiry while it is usable", () => {
    const { session } = setup()
    session.setEnabled(true)
    session.offerCredential(frame())
    expect(session.credentialExpiresAt).toBe(
      new Date(NOW + HOUR_S * 1000).toISOString()
    )
    vi.setSystemTime(NOW + HOUR_S * 1000)
    expect(session.credentialExpiresAt).toBeNull()
    expect(session.needsCredential).toBe(true)
  })
})

describe("a 401", () => {
  test("in a frame: the pair is refused, and asked for again", async () => {
    const { session, sockets, calls } = await liveSession()
    const before = calls.asks
    sockets[0]?.receive(ERROR_401)
    expect(session.machine.state).toBe("no-credential")
    expect(session.live).toBe(false)
    expect(calls.asks).toBe(before + 1)
    expect(sockets[0]?.closed).toBe(true)
    expect(session.credentialExpiresAt).toBeNull()
    expect(calls.frames).toHaveLength(1)
  })

  test("the same pair pushed again is not retried, a new one is", async () => {
    const { session, sockets, calls } = await liveSession()
    sockets[0]?.receive(ERROR_401)
    const oks = calls.oks
    session.offerCredential(frame())
    await settled()
    expect(calls.oks).toBe(oks)
    expect(sockets).toHaveLength(1)
    session.offerCredential(frame(TOKEN, "a-new-key"))
    await settled()
    expect(calls.oks).toBe(oks + 1)
    expect(sockets).toHaveLength(2)
  })

  test("on the upgrade: the same", async () => {
    const { session, calls } = setup(undefined, {
      connect: () => Promise.reject(UNAUTHORIZED_UPGRADE),
    })
    session.setEnabled(true)
    session.offerCredential(frame())
    await settled()
    expect(session.machine.state).toBe("no-credential")
    expect(calls.asks).toBe(2)
  })
})

describe("an expired credential", () => {
  test("takes a live session down at the next tick, and asks", async () => {
    const { session, sockets, calls } = await liveSession()
    const asks = calls.asks
    vi.setSystemTime(NOW + HOUR_S * 1000)
    session.tick()
    expect(session.machine.state).toBe("no-credential")
    expect(sockets[0]?.closed).toBe(true)
    expect(calls.asks).toBe(asks + 1)
  })
})

describe("liveness and the backoff", () => {
  test("silence: a ping at 15 s, dead at 28 s, a retry 1 s later", async () => {
    const { session, sockets } = await liveSession()
    const first = sockets[0]
    await vi.advanceTimersByTimeAsync(15_000)
    expect(first?.sent.at(-1)).toEqual(encodePing())
    expect(session.machine.state).toBe("live")
    await vi.advanceTimersByTimeAsync(13_000)
    expect(session.machine.state).toBe("backoff")
    expect(first?.closed).toBe(true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(sockets).toHaveLength(2)
    expect(session.machine.state).toBe("connecting")
  })

  test("a frame puts the ping off", async () => {
    const { session, sockets } = await liveSession()
    await vi.advanceTimersByTimeAsync(14_000)
    sockets[0]?.receive(TAPE)
    await vi.advanceTimersByTimeAsync(14_000)
    expect(sockets[0]?.sent.at(-1)).not.toEqual(encodePing())
    expect(session.live).toBe(true)
  })

  test("connects fail at 1, 2, 4, 8 s, then wait for the alarm", async () => {
    const attempts: Array<number> = []
    const { session } = setup(undefined, {
      connect: () => {
        attempts.push(Date.now() - NOW)
        return Promise.reject(new Error("challenged"))
      },
    })
    session.setEnabled(true)
    session.offerCredential(frame())
    await vi.advanceTimersByTimeAsync(60_000)
    expect(attempts).toEqual([0, 1000, 3000, 7000, 15_000])
    session.tick()
    await settled()
    expect(attempts).toHaveLength(5)
    await vi.advanceTimersByTimeAsync(300_000 - 45_000)
    session.tick()
    await settled()
    expect(attempts).toHaveLength(6)
  })

  test("a stale socket's close does nothing", async () => {
    const { session, sockets } = await liveSession()
    const first = sockets[0]
    await vi.advanceTimersByTimeAsync(29_000)
    await settled()
    sockets[1]?.receive(TAPE)
    first?.serverClose()
    expect(session.live).toBe(true)
  })

  test("the close of trade closes the socket and goes idle", async () => {
    let open = true
    const { session, sockets } = setup(undefined, { open: () => open })
    session.setEnabled(true)
    session.offerCredential(frame())
    await settled()
    sockets[0]?.receive(TAPE)
    open = false
    session.tick()
    expect(session.machine.state).toBe("idle")
    expect(sockets[0]?.closed).toBe(true)
    open = true
    session.tick()
    await settled()
    expect(sockets).toHaveLength(2)
  })
})

describe("what moves connecting to live", () => {
  const connecting = async () => {
    const context = setup()
    context.session.setEnabled(true)
    context.session.offerCredential(frame())
    await settled()
    expect(context.session.machine.state).toBe("connecting")
    return context
  }

  test.each([
    ["a tape frame", TAPE],
    ["a liveprice frame", LIVEPRICE],
  ])("%s does", async (_name, bytes) => {
    const { session, sockets } = await connecting()
    sockets[0]?.receive(bytes)
    expect(session.machine.state).toBe("live")
  })

  test.each([
    ["a pong", PONG],
    ["a non-401 error frame", ERROR_500],
    ["a malformed frame", new Uint8Array([0xff])],
  ])("%s does not, and the silence still drops it", async (_name, bytes) => {
    const { session, sockets } = await connecting()
    await vi.advanceTimersByTimeAsync(14_000)
    sockets[0]?.receive(bytes)
    expect(session.machine.state).toBe("connecting")
    await vi.advanceTimersByTimeAsync(14_000)
    expect(session.machine.state).toBe("backoff")
  })
})

describe("a live socket with a dead tape", () => {
  test("a pong keeps it alive through the break", async () => {
    const { session, sockets } = await liveSession()
    for (let round = 0; round < 4; round++) {
      await vi.advanceTimersByTimeAsync(15_000)
      expect(sockets[0]?.sent.at(-1)).toEqual(encodePing())
      sockets[0]?.receive(PONG)
    }
    expect(session.machine.state).toBe("live")
    expect(sockets).toHaveLength(1)
  })

  test("an error frame does not", async () => {
    const { session, sockets } = await liveSession()
    await vi.advanceTimersByTimeAsync(15_000)
    sockets[0]?.receive(ERROR_500)
    await vi.advanceTimersByTimeAsync(13_000)
    expect(session.machine.state).toBe("backoff")
  })
})

describe("frames", () => {
  test("reach the relay decoded, and a 401 does not", async () => {
    const { sockets, calls } = await liveSession()
    sockets[0]?.receive(TAPE)
    expect(calls.frames.at(-1)).toEqual({
      channel: "running_trade_batch",
      trades: [],
      undecodable: 0,
    })
    const count = calls.frames.length
    sockets[0]?.receive(ERROR_401)
    expect(calls.frames).toHaveLength(count)
  })

  test("the first one tells the relay the session is live", async () => {
    const { calls } = await liveSession()
    expect(calls.changes).toBeGreaterThan(0)
  })

  test("a changed liveprice list re-sends the whole channel, once", async () => {
    const { session, sockets } = await liveSession()
    const before = sockets[0]?.sent.length ?? 0
    session.setLiveprice([Symbol.make("BBCA")])
    expect(sockets[0]?.sent).toHaveLength(before)
    session.setLiveprice([Symbol.make("BBCA"), Symbol.make("BBRI")])
    expect(sockets[0]?.sent.at(-1)).toEqual(
      encodeChannel(PAIR, [Symbol.make("BBCA"), Symbol.make("BBRI")])
    )
  })
})

describe("a restart", () => {
  test("a session that was live reconnects on the stored pair, without the tab", async () => {
    const { data } = await liveSession()
    const { session, sockets, calls } = setup({
      machine: { state: "live", tries: 0, retryAt: 0 },
      ...(data.credential ? { credential: data.credential } : {}),
    })
    expect(session.live).toBe(false)
    expect(session.machine.state).toBe("backoff")
    await vi.advanceTimersByTimeAsync(1000)
    expect(sockets[0]?.sent[0]).toEqual(encodeAuth(PAIR))
    expect(calls.asks).toBe(0)
  })

  test("a disabled session stays disabled", () => {
    const { session, sockets } = setup({ machine: DISABLED })
    expect(session.machine).toEqual(DISABLED)
    expect(sockets).toEqual([])
  })
})

describe("the logs", () => {
  test("carry no token, key or frame on any path", async () => {
    const { session, sockets, calls } = await liveSession()
    sockets[0]?.receive(ERROR_401)
    session.offerCredential(frame())
    session.offerCredential("garbage")
    session.offerCredential(frame(TOKEN, "a-new-key"))
    await settled()
    await vi.advanceTimersByTimeAsync(29_000)
    session.setEnabled(false)
    const all = calls.logs.join("\n")
    expect(calls.logs.length).toBeGreaterThan(3)
    for (const secret of [TOKEN, KEY, "a-new-key", frame(), "secret-signature"])
      expect(all).not.toContain(secret)
  })
})
