// PROTOTYPE (prototype/whale-threshold-replay): the pure logic behind sweeps
// and walls, as decided on wayfinder ticket #91. No DOM in here; the page and
// the node smoke run both drive it through feed(). Liftable later.
//
// Trade row (from the capture): [symbol, price, volume(shares), side B/S/-,
// time, trade_number, board, value]. Liveprice row: [recv, symbol, price,
// quantity, order_verb, order_number, match_number].

export const defaults = {
  percentile: 0.99,
  closeMs: 500,
  wallGap: 10,
  wallWindowMs: 1000,
  prior: "synthetic", // "none" | "synthetic"
  priorWeight: 1000,
  boards: ["RG"],
}

const lotsOf = (volume) => volume / 100

export const createState = (priors = {}) => ({
  symbols: new Map(),
  priors, // symbol -> number[] of previous-session aggressor-order lots; "*" market-wide
  sweeps: [],
  walls: [],
  makerOrders: new Map(), // order_number -> hit record
  pendingLive: new Map(), // "SYM:tradeNumber" -> liveprice rows seen before the print
  tape: [], // every trade fed, with the verdicts attached
  fed: { batches: 0, trades: 0, live: 0, lastT: null },
})

const sym = (state, symbol) => {
  let s = state.symbols.get(symbol)
  if (!s) {
    s = { orders: [], open: null, prints: [], trades: new Map(), history: [] }
    state.symbols.set(symbol, s)
  }
  return s
}

/** Weighted nearest-rank percentile over prior (rescaled) plus today's orders. */
export const threshold = (state, symbol, cfg) => {
  const s = state.symbols.get(symbol)
  const today = s ? s.orders : []
  let prior = []
  let priorNote = "none"
  if (cfg.prior === "synthetic") {
    if (state.priors[symbol]?.length) {
      prior = state.priors[symbol]
      priorNote = "own"
    } else if (state.priors["*"]?.length) {
      prior = state.priors["*"]
      priorNote = "market"
    }
  }
  const w = prior.length ? cfg.priorWeight / prior.length : 0
  const rows = [
    ...prior.map((l) => [l, w]),
    ...today.map((l) => [l, 1]),
  ].sort((a, b) => a[0] - b[0])
  const total = rows.reduce((n, r) => n + r[1], 0)
  if (!total) return { value: null, n: today.length, warming: true, priorNote }
  const target = cfg.percentile * total
  let cum = 0
  let value = rows.at(-1)[0]
  for (const [l, wt] of rows) {
    cum += wt
    if (cum >= target) {
      value = l
      break
    }
  }
  const priorMass = w * prior.length
  const warming = prior.length ? priorMass > today.length : today.length < 100
  return { value, n: today.length, warming, priorNote }
}

const fmtTime = (iso) =>
  new Date(Date.parse(iso) + 7 * 3_600_000).toISOString().slice(11, 19)

const closeOrder = (state, symbol, s, events, why) => {
  const o = s.open
  if (!o) return
  s.open = null
  s.orders.push(o.lots)
  s.history.push({ i: s.orders.length, lots: o.lots, threshold: o.threshold })
  if (o.sweep) {
    o.sweep.closed = true
    events.push({ kind: "sweep-closed", symbol, sweep: o.sweep, why })
  }
}

const openOrder = (state, symbol, s, t, cfg, events) => {
  const thr = threshold(state, symbol, cfg)
  s.open = {
    side: t.side,
    time: t.time,
    lastRecv: t.recv,
    lots: 0,
    first: t.tradeNumber,
    last: t.tradeNumber,
    n: 0,
    prices: [],
    value: 0,
    threshold: thr.value,
    warming: thr.warming,
    priorNote: thr.priorNote,
    sweep: null,
  }
  events.push({ kind: "order-opened", symbol, side: t.side, time: t.time })
}

const grow = (state, symbol, s, t, cfg, events) => {
  const o = s.open
  o.lots += lotsOf(t.volume)
  o.n++
  o.last = t.tradeNumber
  o.value += t.value
  o.lastRecv = t.recv
  if (o.prices.at(-1) !== t.price) o.prices.push(t.price)
  if (!o.sweep && o.threshold !== null && o.lots >= o.threshold) {
    o.sweep = {
      symbol,
      side: o.side,
      time: o.time,
      at: fmtTime(o.time),
      first: o.first,
      threshold: o.threshold,
      warming: o.warming,
      priorNote: o.priorNote,
      closed: false,
      order: o,
    }
    state.sweeps.push(o.sweep)
    t.verdict = "sweep"
    events.push({ kind: "sweep-announced", symbol, sweep: o.sweep })
  } else if (o.sweep) {
    t.verdict = "sweep"
    events.push({ kind: "sweep-grew", symbol, sweep: o.sweep })
  }
}

const feedTrade = (state, row, recv, cfg, events) => {
  const [symbol, price, volume, side, time, tradeNumber, board, value] = row
  const t = {
    symbol,
    price,
    volume,
    side,
    time,
    tradeNumber,
    board,
    value,
    recv,
    verdict: null,
  }
  state.tape.push(t)
  state.fed.trades++
  const s = sym(state, symbol)
  s.trades.set(tradeNumber, t)
  s.prints.push(lotsOf(volume))
  const pending = state.pendingLive.get(`${symbol}:${tradeNumber}`)
  if (pending) {
    state.pendingLive.delete(`${symbol}:${tradeNumber}`)
    for (const l of pending) attachLive(state, l, t, cfg, events)
  }
  if (!cfg.boards.includes(board) || side === "-") {
    t.verdict = "unflagged-board"
    return
  }
  if (s.open && (s.open.side !== side || s.open.time !== time))
    closeOrder(state, symbol, s, events, "next order")
  if (!s.open) openOrder(state, symbol, s, t, cfg, events)
  grow(state, symbol, s, t, cfg, events)
}

/** Closes every order idle for longer than closeMs, measured on receive time. */
export const closeIdle = (state, nowIso, cfg, events = []) => {
  const now = Date.parse(nowIso)
  for (const [symbol, s] of state.symbols)
    if (s.open && now - Date.parse(s.open.lastRecv) > cfg.closeMs)
      closeOrder(state, symbol, s, events, `${cfg.closeMs} ms idle`)
  return events
}

// ── walls ──────────────────────────────────────────────────────────────

const attachLive = (state, l, trade, cfg, events) => {
  const [recv, symbol, price, quantity, verb, orderNumber] = l
  let m = state.makerOrders.get(orderNumber)
  if (!m) {
    m = {
      orderNumber,
      symbol,
      verb,
      price,
      hits: 0,
      lots: 0,
      firstSeen: recv,
      lastSeen: recv,
      wall: null,
    }
    state.makerOrders.set(orderNumber, m)
    // merge split orders: same symbol, side, price, numbers within gap, first seen within window
    const n = Number(orderNumber.slice(8))
    let wall = state.walls.find(
      (w) =>
        w.symbol === symbol &&
        w.verb === verb &&
        w.price === price &&
        w.members.some((x) => Math.abs(Number(x.orderNumber.slice(8)) - n) <= cfg.wallGap) &&
        Math.abs(Date.parse(w.firstSeen) - Date.parse(recv)) <= cfg.wallWindowMs
    )
    if (!wall) {
      wall = {
        symbol,
        verb,
        side: verb === "S" ? "offer" : "bid",
        price,
        members: [],
        hits: 0,
        lots: 0,
        firstSeen: recv,
        lastSeen: recv,
        announced: false,
        threshold: null,
      }
      state.walls.push(wall)
    }
    wall.members.push(m)
    m.wall = wall
  }
  m.hits++
  m.lots += lotsOf(quantity)
  m.lastSeen = recv
  const w = m.wall
  w.hits++
  w.lots += lotsOf(quantity)
  w.lastSeen = recv
  if (trade) trade.maker = orderNumber
  if (!w.announced) {
    const thr = threshold(state, symbol, cfg)
    if (thr.value !== null && w.lots >= thr.value) {
      w.announced = true
      w.threshold = thr.value
      w.warming = thr.warming
      events.push({ kind: "wall-announced", symbol, wall: w })
    }
  } else events.push({ kind: "wall-grew", symbol, wall: w })
}

const feedLive = (state, l, cfg, events) => {
  const [, symbol, , , , , matchNumber] = l
  state.fed.live++
  const tradeNumber = Number(matchNumber.slice(8))
  const trade = state.symbols.get(symbol)?.trades.get(tradeNumber)
  if (trade) attachLive(state, l, trade, cfg, events)
  else {
    const key = `${symbol}:${tradeNumber}`
    state.pendingLive.set(key, [...(state.pendingLive.get(key) ?? []), l])
  }
}

// ── driver ─────────────────────────────────────────────────────────────

/** Feeds one event from the merged stream: {kind:"batch", t, trades} or {kind:"lp", t, row}. */
export const feed = (state, ev, cfg) => {
  const events = []
  if (ev.kind === "batch") {
    state.fed.batches++
    for (const row of ev.trades) feedTrade(state, row, ev.t, cfg, events)
  } else feedLive(state, ev.row, cfg, events)
  state.fed.lastT = ev.t
  closeIdle(state, ev.t, cfg, events)
  return events
}

export const mergeStream = (batches, liveprice) =>
  [
    ...batches.map((b) => ({ kind: "batch", t: b.t, trades: b.trades })),
    ...liveprice.map((row) => ({ kind: "lp", t: row[0], row })),
  ].sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0))

/** Previous-session stand-in: aggressor orders from the events before `untilT`, grouped with the same rule. */
export const buildPriors = (stream, untilT, cfg) => {
  const state = createState({})
  for (const ev of stream) {
    if (ev.t >= untilT) break
    feed(state, ev, { ...cfg, prior: "none" })
  }
  for (const s of state.symbols.values()) if (s.open) { s.orders.push(s.open.lots); s.open = null }
  const priors = {}
  const all = []
  for (const [symbol, s] of state.symbols) {
    if (s.orders.length) priors[symbol] = s.orders
    all.push(...s.orders)
  }
  priors["*"] = all
  return priors
}

// ── presentation helpers (pure) ────────────────────────────────────────

export const idr = (n) => Math.round(n).toLocaleString("id-ID")
export const money = (v) =>
  v >= 1e9
    ? (v / 1e9).toLocaleString("id-ID", { maximumFractionDigits: 2 }) + "B"
    : (v / 1e6).toLocaleString("id-ID", { maximumFractionDigits: 0 }) + "M"

export const sweepLine = (sw) => {
  const o = sw.order
  const price = o.prices.length > 1 ? `${o.prices[0]}–${o.prices.at(-1)}` : `${o.prices[0]}`
  const side = sw.side === "B" ? "Sweep buy" : "Sweep sell"
  return `${sw.at}\t${sw.symbol}\t${side}\t${idr(o.lots)} at ${price}\t${money(o.value)}\t${o.n} freq`
}
