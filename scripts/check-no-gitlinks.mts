// Fails on a submodule entry in the index. Workers Builds runs
// `git submodule update` after cloning and fails on one with no mapping in the
// root .gitmodules, which is how a `git subtree` pull of repos/alchemy brings
// its submodules back. Not a cached test: turbo can't key on the git index.
import { execFileSync } from "node:child_process"
import { resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")
const gitlinks = execFileSync("git", ["ls-files", "--stage"], {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 256 * 1024 * 1024,
})
  .split("\n")
  .filter((line) => line.startsWith("160000 "))
  .map((line) => line.split("\t")[1])

if (gitlinks.length > 0) {
  console.error(
    `Submodule entries break the Workers Builds clone. Remove them with \`git rm --cached <path>\` (repos/ is reference only):\n${gitlinks.join("\n")}`
  )
  process.exit(1)
}
console.log("No submodule entries in the index.")
