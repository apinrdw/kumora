# The worker reads Stockbit's cookies with chrome.cookies

The service worker reads the Stockbit tab's cookies with `chrome.cookies`, under the `cookies` permission, because it sees the HttpOnly cookies the page's `document.cookie` hides, and `sb_social_access_token` may be one. The cookies stay the tab's: with no Stockbit tab attached there is no answer, as when the tab read them.

Sites:

- `apps/extension/src/worker/stockbit.ts`

Source: apinrdw/kumora#591
