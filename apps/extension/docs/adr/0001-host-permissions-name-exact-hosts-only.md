# Host permissions name exact hosts only

The manifest's host permissions name each dashboard host exactly, never a `*.workers.dev` wildcard. `workers.dev` is on the Public Suffix List, so a wildcard would admit any Workers site, not only ours. The extra target's ingest socket needs no host permission, so no wildcard is needed to reach a Preview or Dev stage.

Sites:

- `apps/extension/manifest.ts`

Source: apinrdw/kumora#135
