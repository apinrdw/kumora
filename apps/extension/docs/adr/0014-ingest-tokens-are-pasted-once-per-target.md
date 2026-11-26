# Ingest tokens are pasted once per target

The relay sends to Production and at most one extra target, each with its own ingest token. The owner pastes each target's ingest token once on the options page, and the worker keeps it in `chrome.storage.local`. Pairing the extension from the dashboard was considered and rejected.

Sites:

- `apps/extension/src/worker/settings.ts`

Source: apinrdw/kumora#134
