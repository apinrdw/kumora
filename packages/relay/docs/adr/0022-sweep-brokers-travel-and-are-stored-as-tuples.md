# Sweep brokers travel and are stored as tuples

Sweep brokers travel, and are stored, as tuples, not keyed objects: an entry is `[first trade, pieces]`, a piece `[sweep tuple, aggressor side, other side]`, and a broker `[code, investor type, lots, minor type's lots only when nonzero]`. A busy code has 10–18 K sweeps a day, which answered 1–2 MB as tuples when an entry was `[first trade, aggressor, other]`.

Sites:

- `packages/relay/src/recorded-day.ts`

Source: apinrdw/kumora#343, apinrdw/kumora#349
