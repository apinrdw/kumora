# A target's URL is stored under the key `origin`

The extra target's settings and the catch-up values kept for it sit in `chrome.storage.local`. They held the dashboard's origin under the key `origin` until the dashboard moved under `/dashboard` (`docs/adr/0020-the-dashboard-is-served-under-dashboard-on-every-stage.md`), when the value became the dashboard's Stage URL, which may carry a path. The field is `url` in code, and its encoding keeps the stored key `origin`, so a relay updated in place still loads the extra target set before, and the catch-up positions kept for it.

Keeping the key is not enough on its own: an older relay saved the origin alone, and a dashboard now answers its root with a redirect that the ingest socket cannot follow and that turns a broker codes POST into a GET. So a target's URL is read through one rule, `TargetUrl`: a URL with no path names that dashboard at the dashboard base path, and a URL with a path is kept as is. The rule decodes the stored settings, the catch-up values' URLs, and the URL the owner types on the options page, so a saved root, a kept position and a typed root all land on the same URL, and a moved target neither walks again nor loses its position. Saving writes the URL back with its path.

Renaming the stored key would have dropped every saved extra target and its kept positions on update, and the owner would set the target again. Undoing this means a migration that reads `origin` and writes the new key, or accepting that loss. Dropping the rule means every saved root target stops receiving until the owner types its path.

Sites:
- `apps/extension/src/worker/settings.ts`
- `apps/extension/src/options/form.ts`

Source: apinrdw/kumora#683
