// Fails when a branch changes, renames or deletes a D1 migration that a
// deployed stage may have applied. Alchemy hashes each applied migration and
// refuses the deploy when one changed, even in a comment ("rewritten" history
// in repos/alchemy/packages/sql/src/Migrations/Registry.ts), and nothing local
// fails with it. Two stages apply a branch's migrations: Staging applied every
// migration on the base branch, and the branch's Preview applied every one it
// pushed. Spec #479 edited one its Preview had applied and broke every
// dashboard Workers Build; spec #643's apply nearly edited eight on Staging.
// Not a cached test: turbo can't key on git history, and CI's static job
// checks out full history.
import { Console, Effect } from "effect"

import { CheckFailed } from "./lib/check.mts"
import { gitLines, stdoutOf } from "./lib/command.mts"

const migrations = ":(glob)apps/*/*migrations/**"

// The migrations that exist at `rev` and differ at HEAD.
const touchedSince = Effect.fn("touchedSince")(function* (
  root: string,
  rev: string
) {
  return yield* gitLines(root, [
    "diff",
    "--name-only",
    "--no-renames",
    "--diff-filter=a",
    rev,
    "HEAD",
    "--",
    migrations,
  ])
})

// Where this branch last met its pushed head, which its Preview deployed, or
// nothing on a detached HEAD or a branch never pushed. The meeting point, not
// the pushed head itself, so a migration pushed from elsewhere and not yet
// pulled doesn't read as deleted.
const pushedHead = Effect.fn("pushedHead")(function* (root: string) {
  const [branch] = yield* gitLines(root, ["branch", "--show-current"])
  if (branch === undefined) return []
  const [pushed] = yield* gitLines(root, [
    "for-each-ref",
    "--format=%(refname)",
    `refs/remotes/origin/${branch}`,
  ])
  if (pushed === undefined) return []
  return yield* gitLines(root, ["merge-base", pushed, "HEAD"])
})

export const checkAppliedMigrations = Effect.fn("checkAppliedMigrations")(
  function* (root: string, base: string) {
    const mergeBase = (yield* stdoutOf("git", ["merge-base", base, "HEAD"], {
      cwd: root,
    })).trim()
    const onBase = yield* touchedSince(root, mergeBase)
    const pushed = yield* pushedHead(root)
    const onPreview = (yield* Effect.forEach(pushed, (rev) =>
      touchedSince(root, rev)
    )).flat()
    const touched = [...new Set([...onBase, ...onPreview])].sort()
    if (touched.length > 0)
      return yield* new CheckFailed({
        summary: `These D1 migrations exist on ${base} or on this branch's pushed head, so Staging or this branch's Preview has applied them, and Alchemy refuses to deploy one that changed, even in a comment. Restore each as it was there (\`git checkout <that ref> -- <file>\`) and write the change as a new migration:`,
        findings: touched,
      })
    yield* Console.log(
      `No applied D1 migration changed since ${base}${pushed.length > 0 ? " or this branch's pushed head" : ""}.`
    )
  }
)
