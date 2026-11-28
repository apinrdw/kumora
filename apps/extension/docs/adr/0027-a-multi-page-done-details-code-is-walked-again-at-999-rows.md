# A multi-page Done Details code is walked again at 999 rows

Ajaib's Done Details route pages by offset with a skip: page k of size P starts at offset (k−1)·(P+1) and holds P rows, so a pass at 1,000 rows a page never sees the row at each page boundary. Pairing by row order (ADR 0026) is greedy, so a missing row inside a tie shifts every later row of that key onto the wrong trade. A code whose first pass at 1,000 took more than one page gets a second pass at 999 rows a page, whose boundaries fall elsewhere, and the two passes' rows merge by offset, each offset once (a copy either pass read over one it couldn't), before the code is matched. This is what the owner's console collector does, and the tape walk's 50,000 / 49,999 passes (ADR 0024). A single-page code skips nothing and gets no second pass. The second pass asks every page again rather than only the boundary rows: the route has no way to ask for one offset.

Each stored row keeps its offset, and the walk's position names its pass (`pass: "first"` at 1,000 or `"second"` at 999) next to the code and page, saved after each page as the first pass's are, so a restarted worker resumes the pass it was on. The step from the first pass to the second keeps the first pass's last page with the position, and only a code's first page of its first pass forgets the rows. Rows stored by version 4 of the store have no offset to merge by, so version 5's upgrade from 4 clears the rows and moves a position on a code back to that code's first page of its first pass; the day's tape trades and matched trades stay, unlike ADR 0003's drop of older versions.

Sites:

- `apps/extension/src/worker/broker-codes/done-details-walk.ts`
- `apps/extension/src/worker/broker-codes/done-details-store.ts`

Source: apinrdw/kumora#750
