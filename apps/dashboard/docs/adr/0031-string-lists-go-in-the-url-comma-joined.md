# String lists go in the URL comma-joined

A list of strings with no commas is written into the URL comma-joined, so the stock page's chips read `brokers=buy,sell,YP` as the spec names it, not the router's JSON `["buy","sell","YP"]`. It reads back as one string, which the page's `validateSearch` splits into its typed list. Any other object is JSON, as the router writes it by default.

Sites:
- `apps/dashboard/src/lib/search-url.ts`

Source: apinrdw/kumora#437
