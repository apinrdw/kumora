// The Preview sweep (`teardown sweep`), run daily and by hand by
// .github/workflows/teardown-preview.yml: lists every Preview in the Alchemy
// state store and destroys each Stale Preview, every app, as `teardown
// destroy` does. A dry run destroys nothing. It prints one line per Preview.
import { Command, Flag } from "effect/cli"
import * as Console from "effect/Console"
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

import { errorMessage } from "./report.ts"
import { type Branch, GitHub } from "./github.ts"
import { destroyEveryApp } from "./stacks.ts"
import { StoredStages } from "./stored-stages.ts"
import { APPS, Preview, stageForBranch } from "./target.ts"

// Every Stale Preview has been tried before this fails, so one bad Preview
// never keeps the others alive.
class SweepFailed extends Schema.TaggedError<SweepFailed>()("SweepFailed", {
  failures: Schema.Array(
    Schema.Struct({
      stage: Preview,
      app: Schema.Literals(APPS),
      error: Schema.Defect(),
    })
  ),
}) {
  override get message() {
    return [
      "Sweeping Previews failed:",
      ...this.failures.map(
        // Error calls this getter synchronously, and errorMessage is pure.
        ({ stage, app, error }) =>
          `  ${stage} ${app}: ${Effect.runSync(errorMessage(error))}`
      ),
    ].join("\n")
  }
}

// A Prototype branch's name starts with this (the Deploy glossary).
const PROTOTYPE_PREFIX = "prototype/"

// How long a branch with no PR keeps its Preview after its head commit.
const GRACE = Duration.days(3)

interface Verdict {
  readonly stale: boolean
  readonly reason: string
}

// The stale rule (Stale Preview in the Deploy glossary), first match wins.
// - A gone branch is stale with no grace: the work is deleted.
// - An open PR keeps a Preview however old its head: a long review needs it.
// - A Prototype branch is pushed for its Preview, so only its deletion ends it.
// - A merged or closed PR with none open is stale with no grace, so a push
//   after the merge can't keep a Preview alive (#79's did).
// - A branch that never had a PR gets a grace, so a developer can look at its
//   Preview before opening the PR, then goes once idle; integration
//   sub-branches merge locally and never get one. Exactly GRACE old is still
//   in grace. The Clock, not Date, so TestClock drives the boundary.
const verdict = Effect.fnUntraced(function* (
  branch: Branch | undefined
): Effect.fn.Return<Verdict> {
  if (branch === undefined) return { stale: true, reason: "branch gone" }
  if (branch.pullRequests === "open") return { stale: false, reason: "open PR" }
  if (branch.name.startsWith(PROTOTYPE_PREFIX))
    return { stale: false, reason: "prototype branch" }
  if (branch.pullRequests === "closed")
    return { stale: true, reason: "PR closed" }
  const now = yield* DateTime.now
  return DateTime.isGreaterThan(
    now,
    DateTime.addDuration(branch.headCommitDate, GRACE)
  )
    ? { stale: true, reason: "no PR, idle" }
    : { stale: false, reason: "no PR, in grace" }
})

// The state store keeps whatever stage alchemy was handed, so only names that
// decode as a Preview are swept: never a Release stage, the Test stage or a
// stray name. Stacks.destroy takes only a Preview, so its type holds this too.
const storedPreviews = Effect.gen(function* () {
  const stored = yield* StoredStages
  const names = (yield* Effect.forEach(APPS, stored.list)).flat()
  return [...new Set(names)]
    .flatMap((name) =>
      Option.toArray(Schema.decodeUnknownOption(Preview)(name))
    )
    .sort()
})

// A Preview's name is a slug plus a hash of the full branch name, so it maps
// back to its branch only forward: from every live branch to its Stage.
const branchesByStage = Effect.gen(function* () {
  const branches = yield* (yield* GitHub).branches
  const entries = yield* Effect.forEach(branches, (branch) =>
    Effect.map(stageForBranch(branch.name), (stage) => [stage, branch] as const)
  )
  return new Map<string, Branch>(entries)
})

export const sweepCommand = Command.make(
  "sweep",
  {
    dryRun: Flag.Boolean("dry-run").pipe(
      Flag.withDescription("List what would be destroyed; destroy nothing"),
      Flag.withDefault(false)
    ),
  },
  Effect.fnUntraced(function* ({ dryRun }) {
    const previews = yield* storedPreviews
    if (previews.length === 0) return
    const branches = yield* branchesByStage
    const failures: Array<SweepFailed["failures"][number]> = []
    for (const stage of previews) {
      const { stale, reason } = yield* verdict(branches.get(stage))
      if (!stale) {
        yield* Console.log(`kept ${stage} (${reason})`)
        continue
      }
      if (dryRun) {
        yield* Console.log(`would destroy ${stage} (${reason})`)
        continue
      }
      const failed = yield* destroyEveryApp(stage)
      failures.push(...failed.map((failure) => ({ stage, ...failure })))
      yield* Console.log(
        `${failed.length === 0 ? "destroyed" : "failed to destroy"} ${stage} (${reason})`
      )
    }
    if (failures.length > 0) return yield* new SweepFailed({ failures })
  })
)
