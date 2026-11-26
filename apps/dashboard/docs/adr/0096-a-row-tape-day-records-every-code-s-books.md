# A row-tape day records every code's books

Days now record books only for viewed codes, but days recorded before that change keep their old behaviour rather than being rewritten. A day whose tape is a row per trade records every code's books to the close, never answers a code not recorded, and writes no recorded books set. Every day since is chunked from its first trade, so its set starts empty.

Sites:

- `apps/dashboard/src/server/market-live/recorded-books.ts`

Source: apinrdw/kumora#555
