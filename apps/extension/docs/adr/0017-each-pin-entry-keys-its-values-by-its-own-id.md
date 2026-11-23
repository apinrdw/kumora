# Each PIN entry keys its values by its own id

`chrome.storage` has no compare-and-set to guard one shared key, and a PIN check or lock screen can still be busy with an older entry when the owner enters a new PIN. So each entry keeps its PIN, sign-in and `typing` mark under keys named by its own id, `ENTRY_KEY` names the newest, and one read takes them all. Work on an older entry writes that entry's keys only, never the newest one's.

Sites:
- `apps/extension/src/worker/settings.ts`

Source: apinrdw/kumora#255
