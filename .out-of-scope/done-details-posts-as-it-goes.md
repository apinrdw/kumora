# Done Details posting as it goes

Ajaib's Done Details walk holds every matched trade until it has walked the day's last stock code, then posts them all in trade order. It does not post a code's matches as soon as that code is walked.

## Why this is out of scope

ADR 0005 (`apps/extension/docs/adr/0005-matched-trades-post-after-the-last-code-in-trade-order.md`) decides this. Held to the end and posted in trade order, each batch of 5,000 rows spans a minute or two of the day, so the dashboard's sweep brokers recompute regroups each market minute about once. Posted per stock code, every batch would span the whole day, and each market minute would be regrouped once per code: about 900 times on a busy day. Coalescing the posts on the dashboard was rejected too, because it would write rows after a batch's 200 answer.

The cost of holding is a quiet stretch: on 2026-11-27 the walk fetched from 17:10 to 17:24 WIB and Production received nothing until it posted ~190 batches at the end. That is expected. The Broker codes card shows the walk moving as "x of y codes", and the walk's held position survives a worker restart.

A trade's two order numbers both come from its stock code's Done Details pages (`MatchedTrade` in `done-details-walk.ts`), so posting early would not need two codes walked; the reason is the recompute, not completeness.

Revisit this only alongside ADR 0005, with a cheaper recompute on the dashboard.

## Prior requests

- #742: "Ajaib's Done Details walk posts order numbers as it goes, not all at the end"
