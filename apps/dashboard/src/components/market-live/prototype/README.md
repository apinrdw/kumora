# Order flow marks prototype (throwaway)

This answers [How the order flow marks, event rows and heavy side chip look](https://github.com/apinrdw/kumora/issues/604), part of [Map: Order flow events](https://github.com/apinrdw/kumora/issues/593). It is never merged.

- `order-flow-marks.html` is one static file with simulated BBCA data. Open it at `#arrows`, `#lettered` or `#lane`. Published copy: https://claude.ai/artifact/2FhzWw6SMDZHBBFu41fv3e
- `order-flow-marks-b-lettered.png` is the winning variant.

**Verdict (owner, 2026-11-20):**

- **Variant B wins.** An order flow event shows ▲ above the candle's high for a buying-side event and ▼ below its low for a selling-side one, coloured by aggressor side. The kind's letter sits beside the mark: **E** for Exhaustion, **D** for Delta divergence, **F** for Failed break. The footprint chart puts the same mark above the minute's column.
- The heavy side chip, the "118 vs 22" scanner figure and the readout line "−72% · Offer-heavy · big orders" stay as shown: amber for big orders, grey for small orders.
- Feed and readout rows drop the "order flow" / "book" tag. The mark and the title are enough.
