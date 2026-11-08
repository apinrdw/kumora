import { Effect, Path, Schema } from "effect"

// The one failure every check script ends with: what is wrong, then each
// offending file, line or entry on its own line.
export class CheckFailed extends Schema.TaggedError<CheckFailed>()(
  "CheckFailed",
  {
    summary: Schema.String,
    findings: Schema.Array(Schema.String),
  }
) {
  override get message() {
    return [this.summary, ...this.findings].join("\n")
  }
}

// The repo root, which every check reads from.
export const repoRoot = Effect.map(Path.Path, (path) =>
  path.resolve(import.meta.dirname, "../..")
)
