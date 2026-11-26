# A target's URL is stored under the key `origin`

The extra target's settings and the catch-up values kept for it sit in `chrome.storage.local`. They held the dashboard's origin under the key `origin` until the dashboard moved under `/dashboard` (`docs/adr/0020-the-dashboard-is-served-under-dashboard-on-every-stage.md`), when the value became the dashboard's Stage URL, which may carry a path. The field is `url` in code, and its encoding keeps the stored key `origin`, so a relay updated in place still loads the extra target set before, and the catch-up positions kept for it.

Renaming the stored key would have dropped every saved extra target and its kept positions on update, and the owner would set the target again. Undoing this means a migration that reads `origin` and writes the new key, or accepting that loss.

Sites:
- `apps/extension/src/worker/settings.ts`

Source: apinrdw/kumora#683
