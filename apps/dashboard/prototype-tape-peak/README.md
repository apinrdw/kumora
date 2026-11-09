# PROTOTYPE, throw away: whole-market tape at peak

Answers "How many trades the whole-market tape keeps and how fast it renders at peak" (apinrdw/kumora#136).

- `trades.js`: 30,000 trades Ajaib delivered on 2026-11-09, 08:58:01–09:00:16 WIB (the 08:58:00 opening match of 22,264 trades plus the session 1 open), as `[receivedMs, code, price, lot, side, tradeSeq, tradedAt]`.
- `index.html`: replays them in 250 ms deltas through three tape variants (`?variant=A|B|C`, arrow keys switch): A virtualised ring, B plain DOM capped, C burst fold.
- `bench.mjs`: headless Chromium run of each variant at 1× and 4× CPU slowdown.

Run: `python3 -m http.server 4173` in this folder, open http://localhost:4173/?variant=A.

Verdict: virtualised, redraw once per frame, keep 10,000 live trades, freeze with an "N new" pill when scrolled, fold auction matches only. Results are on the issue.
