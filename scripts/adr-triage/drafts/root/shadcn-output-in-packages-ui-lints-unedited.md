# shadcn output in packages/ui lints unedited

`packages/ui/src` is regenerable shadcn CLI output, so it sits in no `.oxlintrc.json` override: it is exempt from every Effect ban and keeps only the root import bans. Output from `shadcn add` must lint clean unedited.

Sites:
- `.oxlintrc.json`

Source: apinrdw/kumora#103, apinrdw/kumora#111
