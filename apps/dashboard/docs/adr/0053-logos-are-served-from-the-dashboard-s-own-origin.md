# Logos are served from the dashboard's own origin

Stock logos are served from the dashboard's own origin, so a canvas that draws a logo stays untainted and Market Bubbles' snapshot still exports. They are open to anyone, like any image a page links, so the cache is public.

Sites:

- `apps/dashboard/src/server/logos/serve.ts`

Source: apinrdw/kumora#432
