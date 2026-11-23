# History positions moved to new keys

When a History walk day became a recorded day, both History walk positions moved to new storage keys, so every install walks its History again. A day walked for codes alone lists its trades as missing their fields, and the gap walk fetches them whole; a complete day costs one status GET.

Sites:
- `apps/extension/src/worker/settings.ts`

Source: apinrdw/kumora#437
