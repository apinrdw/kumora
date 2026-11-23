# The Ajaib PIN lives in chrome.storage.session alone

The owner's Ajaib PIN lives in `chrome.storage.session` alone: it is held in memory, cleared when Chrome closes, and out of content scripts' reach. It is never logged, and it leaves the worker only for the Ajaib tab's PIN check and lock screen (`type-pin`). A restarted worker finds its PIN sign-in beside it.

Sites:
- `apps/extension/src/worker/settings.ts`

Source: https://developer.chrome.com/docs/extensions/reference/api/storage
