# The pacer spaces calls and backs off on a throttle

The pacer allows 3 calls a second per broker site, spaced evenly so Cloudflare never sees a burst. A throttle stops the site for 5 minutes, then runs it at half rate, double the spacing, until 10 minutes pass without another; the extension never tries to solve a challenge. Ajaib also allows one call in flight, while Stockbit's limit is the rate alone. A started call's fetch holds its slot until the tab answers or goes, even once its caller is interrupted or gives up after `REQUEST_TIMEOUT`, because the content script's fetch can't be cancelled. The tab going answers every call.

Sites:
- `apps/extension/src/worker/pacer.ts`

Source: apinrdw/kumora#192, apinrdw/kumora#196
