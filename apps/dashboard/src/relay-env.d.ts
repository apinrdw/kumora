// What the Worker reads beyond `secrets.required` in wrangler.jsonc, which
// `wrangler types` writes into worker-configuration.d.ts. vite.config.ts sets it
// from the build's own environment, and a deploy never does.
interface Env {
  /** A whole calendar, as JSON, in place of `CALENDAR`: see `calendarFrom`. */
  readonly RELAY_CALENDAR?: string
}
