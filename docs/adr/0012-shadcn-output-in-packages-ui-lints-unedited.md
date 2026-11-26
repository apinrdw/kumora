# shadcn output in packages/ui lints unedited

`packages/ui/src` is regenerable shadcn CLI output, so it sits in no lint override in `vite.config.ts`: it is exempt from every Effect ban and keeps only the root import bans. Output from `shadcn add` must lint clean unedited.

Sites:
- `vite.config.ts`

Source: apinrdw/kumora#103, apinrdw/kumora#111
