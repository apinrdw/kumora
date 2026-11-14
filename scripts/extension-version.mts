// Fails when the relay extension's build inputs changed since the merge-base
// with the base branch but its version did not. The owner loads the build
// unpacked and tells builds apart by that version on chrome://extensions
// (apps/extension/manifest.ts reads it). Not a cached test: turbo can't key on
// git history, and CI's static job checks out full history for it.
import { Config, Console, Effect, Schema } from "effect"

import { CheckFailed } from "./lib/check.mts"
import { gitLines, stdoutOf } from "./lib/command.mts"

const extension = "apps/extension"
const manifestPackage = `${extension}/package.json`

// Decision: every file under apps/extension is a build input except its
// tests/, any *.md, and vitest.config.ts, which vite build never reads.
// tsconfig.json stays in because vite resolves imports through it. Workspace
// packages the extension imports (relay, ui, deploy) are out: watching them
// would demand a bump for every dashboard-only change to packages/ui.
const notBuildInputs = [
  /^apps\/extension\/tests\//,
  /\.md$/,
  /^apps\/extension\/vitest\.config\.ts$/,
]

const Package = Schema.fromJsonString(Schema.Struct({ version: Schema.String }))

const versionAt = Effect.fn("versionAt")(function* (root: string, rev: string) {
  const { version } = yield* Schema.decodeEffect(Package)(
    yield* stdoutOf("git", ["show", `${rev}:${manifestPackage}`], { cwd: root })
  )
  return version
})

// GitHub sets GITHUB_BASE_REF to the PR's base branch on pull_request runs and
// leaves it empty on a push and locally. Staging is where every PR but a
// Hotfix lands, so a local branch diffs against it, and a push to `staging`
// or a Release's fast-forward of `main` diffs against nothing new.
export const baseRef = Effect.gen(function* () {
  const branch = yield* Config.String("GITHUB_BASE_REF").pipe(
    Config.withDefault("")
  )
  return `origin/${branch === "" ? "staging" : branch}`
})

export const checkExtensionVersion = Effect.fn("checkExtensionVersion")(
  function* (root: string, base: string) {
    const mergeBase = (yield* stdoutOf("git", ["merge-base", base, "HEAD"], {
      cwd: root,
    })).trim()
    const changed = (yield* gitLines(root, [
      "diff",
      "--name-only",
      mergeBase,
      "HEAD",
      "--",
      extension,
    ])).filter((file) => !notBuildInputs.some((rule) => rule.test(file)))
    if (changed.length === 0)
      return yield* Console.log(
        `No relay extension build inputs changed since ${base}.`
      )
    const before = yield* versionAt(root, mergeBase)
    const after = yield* versionAt(root, "HEAD")
    if (before === after)
      return yield* new CheckFailed({
        summary: `The relay extension's build inputs changed since ${base}, but its version is still ${before}. Bump "version" in ${manifestPackage}, which chrome://extensions shows. Changed:`,
        findings: changed,
      })
    yield* Console.log(
      `Relay extension version bumped from ${before} to ${after}.`
    )
  }
)
