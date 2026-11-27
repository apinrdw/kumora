# A multi-page Done Details code is walked again at 999 rows

Ajaib's Done Details route pages by offset with a skip: page k of size P starts at offset (k−1)·(P+1) and holds P rows, so a walk at 1,000 rows a page never sees the row at each page boundary. Pairing by row order (ADR 0026) is greedy, so a missing row inside a tie shifts every later row of that key onto the wrong trade. A code whose first walk at 1,000 took more than one page is walked a second time at 999 rows a page, whose boundaries fall elsewhere, and the two walks' rows merge by offset, each offset once, before the code is matched. This is what the owner's console collector does, and the tape walk's 50,000 / 49,999 passes (ADR 0024). A single-page code skips nothing and isn't walked again. The second walk asks every page again rather than only the boundary rows: the route has no way to ask for one offset.

Each stored row keeps its offset, and the walk's position names its walk (`pass: "first"` at 1,000 or `"second"` at 999) next to the code and page, saved after each page as the first walk's are, so a restarted worker resumes the walk it was on. The step from the first walk to the second keeps the first walk's last page with the position, and only a code's first page of its first walk forgets the rows. Rows stored by version 4 of the store have no offset to merge by, so version 5's upgrade from 4 clears the rows and moves a position on a code back to that code's first page of its first walk; the day's tape trades and matched trades stay, unlike ADR 0003's drop of older versions.

Sites:

- `apps/extension/src/worker/broker-codes/done-details-walk.ts`
- `apps/extension/src/worker/broker-codes/done-details-store.ts`

Source: apinrdw/kumora#750
