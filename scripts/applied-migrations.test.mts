// Runs the check against a real git repository, because the pathspec and the
// diff filter are what decide which files it sees.
import { NodeServices } from "@effect/platform-node"
import { assert, layer } from "@effect/vitest"
import { Effect, FileSystem, Path } from "effect"

import { checkAppliedMigrations } from "./applied-migrations.mts"
import { CheckFailed } from "./lib/check.mts"
import { stdoutOf } from "./lib/command.mts"

const applied = "apps/dashboard/holdings-migrations/0001_init.sql"

// A repo whose `base` branch holds one applied migration and a source file,
// checked out on `branch`, with `change` run on the branch and committed.
const repoWith = Effect.fnUntraced(function* (
  change: (
    root: string
  ) => Effect.Effect<void, unknown, FileSystem.FileSystem | Path.Path>
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "migrations-" })
  const git = (...args: ReadonlyArray<string>) =>
    stdoutOf("git", args, { cwd: root })
  const write = (file: string, text: string) =>
    Effect.gen(function* () {
      yield* fs.makeDirectory(path.dirname(path.join(root, file)), {
        recursive: true,
      })
      yield* fs.writeFileString(path.join(root, file), text)
    })
  yield* git("init", "-q", "-b", "base")
  yield* git("config", "user.email", "test@example.com")
  yield* git("config", "user.name", "test")
  yield* write(applied, "-- holds the month\nCREATE TABLE a (x);\n")
  yield* write("apps/dashboard/src/a.ts", "export {}\n")
  yield* git("add", "-A")
  yield* git("commit", "-q", "-m", "base")
  yield* git("checkout", "-q", "-b", "branch")
  yield* change(root)
  yield* git("add", "-A")
  yield* git("commit", "-q", "--allow-empty", "-m", "change")
  return root
})

layer(NodeServices.layer)("checkAppliedMigrations", (it) => {
  it.effect("passes a new migration and a source change", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* repoWith((dir) =>
        Effect.gen(function* () {
          yield* fs.writeFileString(
            path.join(dir, "apps/dashboard/holdings-migrations/0002_b.sql"),
            "CREATE TABLE b (x);\n"
          )
          yield* fs.writeFileString(
            path.join(dir, "apps/dashboard/src/a.ts"),
            "export const a = 1\n"
          )
        })
      )
      yield* checkAppliedMigrations(root, "base")
    }).pipe(Effect.scoped)
  )

  it.effect("fails a comment edit, a rename and a deletion", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* repoWith((dir) =>
        fs.writeFileString(
          path.join(dir, applied),
          "-- Holds the month\nCREATE TABLE a (x);\n"
        )
      )
      const edited = yield* Effect.flip(checkAppliedMigrations(root, "base"))
      assert.instanceOf(edited, CheckFailed)
      assert.deepStrictEqual(edited.findings, [applied])
      assert.include(edited.summary, "new migration")

      const git = (...args: ReadonlyArray<string>) =>
        stdoutOf("git", args, { cwd: root })
      yield* git("checkout", "-q", "base", "--", applied)
      yield* git(
        "mv",
        applied,
        "apps/dashboard/holdings-migrations/0001_renamed.sql"
      )
      yield* git("commit", "-q", "-m", "rename")
      const renamed = yield* Effect.flip(checkAppliedMigrations(root, "base"))
      assert.instanceOf(renamed, CheckFailed)
      assert.deepStrictEqual(renamed.findings, [applied])

      yield* git(
        "rm",
        "-q",
        "apps/dashboard/holdings-migrations/0001_renamed.sql"
      )
      yield* git("commit", "-q", "-m", "delete")
      const deleted = yield* Effect.flip(checkAppliedMigrations(root, "base"))
      assert.instanceOf(deleted, CheckFailed)
      assert.deepStrictEqual(deleted.findings, [applied])
    }).pipe(Effect.scoped)
  )

  it.effect(
    "fails an edit to a migration the branch pushed, as spec #479 did",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const added = "apps/dashboard/holdings-migrations/0002_b.sql"
        const write = (root: string, text: string) =>
          fs.writeFileString(path.join(root, added), text)
        const root = yield* repoWith((dir) =>
          write(dir, "CREATE TABLE b (x);\n")
        )
        const git = (...args: ReadonlyArray<string>) =>
          stdoutOf("git", args, { cwd: root })
        const editAndCommit = Effect.gen(function* () {
          yield* write(root, "-- edited\nCREATE TABLE b (x);\n")
          yield* git("commit", "-q", "-am", "edit")
        })

        // Unpushed, the Preview never applied it, so an edit passes.
        yield* editAndCommit
        yield* checkAppliedMigrations(root, "base")

        yield* git("update-ref", "refs/remotes/origin/branch", "HEAD")
        yield* write(root, "CREATE TABLE b (y);\n")
        yield* git("commit", "-q", "-am", "edit after push")
        const error = yield* Effect.flip(checkAppliedMigrations(root, "base"))
        assert.instanceOf(error, CheckFailed)
        assert.deepStrictEqual(error.findings, [added])

        // A migration pushed from elsewhere and not yet pulled isn't deleted.
        yield* git("reset", "-q", "--hard", "HEAD~1")
        yield* git("checkout", "-q", "-b", "elsewhere")
        yield* fs.writeFileString(
          path.join(root, "apps/dashboard/holdings-migrations/0003_c.sql"),
          "CREATE TABLE c (x);\n"
        )
        yield* git("add", "-A")
        yield* git("commit", "-q", "-m", "elsewhere")
        yield* git("update-ref", "refs/remotes/origin/branch", "HEAD")
        yield* git("checkout", "-q", "branch")
        yield* checkAppliedMigrations(root, "base")
      }).pipe(Effect.scoped)
  )
})
