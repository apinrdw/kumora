# Order book radar scanner: PROTOTYPE, never merge

Throwaway prototype for [How the scanner looks and ranks](https://github.com/apinrdw/kumora/issues/493), map [#485](https://github.com/apinrdw/kumora/issues/485). Published as https://claude.ai/artifact/V9pUkw2ayyHp8Jj87m4E7T (Version 4).

`order-book-radar.html` is one static page on simulated books, events and alerts. Open it in a browser and switch variants with ◀ ▶ or the arrow keys:

- `#table`: A, ranked table
- `#tug`: B, tug of war
- `#tiles`: C, tiles plus event feed
- `#tug-feed`: D, tug of war plus event feed (**the owner's pick**, 2026-11-18)
- `#tiles-split`: E, split tiles plus event feed

`scanner-d-tug-of-war-feed.png` shows D at 1600×1000.

## Per-code readout on Market Live

`book-readout.html` is the prototype for [How the per-code readout sits on Market Live](https://github.com/apinrdw/kumora/issues/494), published as https://claude.ai/artifact/NEqb7iiBY8zMB8wRhykPUy. It puts the readout in three places:

- `#in-book`: A, inside the Order book panel
- `#own-panel`: B, its own panel in the right column
- `#under-charts`: C, a strip under the charts (**the owner's pick**, 2026-11-18)

Its Try bar switches the code (busy, quiet, Special Monitoring Board, Rp7, at a limit, index), the market phase and a recorded day with a cursor. `readout-c-under-charts.png` shows C at 1680×1100.
