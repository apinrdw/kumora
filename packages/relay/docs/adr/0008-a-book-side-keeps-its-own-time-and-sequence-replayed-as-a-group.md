# A book side keeps its own time and sequence, replayed as a group

Each side of an order book keeps its own frame's time and, from Stockbit, its `sequence_number`, which orders a code's two sides even when their times tie. A sequence has gaps and can arrive out of order, so a gap never means a lost frame. A stored book frame carries all its book's per-side times and sequence numbers, changed or not, and replay replaces them as one group, so a book without one (Ajaib's has no sequences) never inherits the frame before's. An older chunk has none and replays unchanged.

Sites:

- `packages/relay/src/order-book.ts`
- `packages/relay/src/recorded-day.ts`

Source: apinrdw/kumora#517
