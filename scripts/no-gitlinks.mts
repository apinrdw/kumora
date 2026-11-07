// Fails on a submodule entry in the index. Workers Builds runs
// `git submodule update` after cloning and fails on one with no mapping in the
// root .gitmodules, which is how a `git subtree` pull of repos/alchemy brings
// its submodules back. Not a cached test: turbo can't key on the git index.
import { Console, Effect } from "effect"

import { CheckFailed } from "./lib/check.mts"
import { gitLines } from "./lib/command.mts"

export const checkNoGitlinks = Effect.fn("checkNoGitlinks")(function* (
  root: string
) {
  const gitlinks = (yield* gitLines(root, ["ls-files", "--stage"]))
    .filter((line) => line.startsWith("160000 "))
    .map((line) => line.split("\t")[1] ?? line)
  if (gitlinks.length > 0)
    return yield* new CheckFailed({
      summary:
        "Submodule entries break the Workers Builds clone. Remove them with `git rm --cached <path>` (repos/ is reference only):",
      findings: gitlinks,
    })
  yield* Console.log("No submodule entries in the index.")
})
