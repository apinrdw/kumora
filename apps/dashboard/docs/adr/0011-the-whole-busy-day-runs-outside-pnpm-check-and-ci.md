# The whole busy day runs outside vp run check and CI

The whole busy day records for about 280 s in workerd, so it is a Vitest project of its own that `vp run --filter dashboard test:whole-day` runs, left out of `vp run check` and CI. A change to what a day writes or stores runs it, and its PR reports the figures.

Sites:
- `apps/dashboard/vitest.config.ts`

Source: apinrdw/kumora#555
