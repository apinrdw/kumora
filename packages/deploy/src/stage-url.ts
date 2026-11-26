import * as Schema from "effect/Schema"

// A Stage URL (GLOSSARY.md): an http(s) URL whose path, when it has one, never
// ends in `/`, with no query or fragment, so a path joins on as
// `${url}${path}`. stageUrl (target.ts) builds one; a Worker decodes its
// binding into one. Its own module, so a Worker imports it without target.ts's
// node:crypto and alchemy Config. The relay holds each target dashboard's URL
// as one (apps/extension/src/worker/settings.ts).
// Decision: the dashboard is served under /dashboard on every Stage
// (docs/adr/0020-the-dashboard-is-served-under-dashboard-on-every-stage.md)
export const StageUrl = Schema.String.check(
  Schema.isPattern(/^https?:\/\/[^/\s?#]+(?:\/[^\s?#]*[^/\s?#])?$/)
).pipe(Schema.brand("StageUrl"))
export type StageUrl = typeof StageUrl.Type
