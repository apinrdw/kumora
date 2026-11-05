// Fails when a package.json script pipes a command that can fail into another.
// npm runs scripts under sh, which has no pipefail: the producer's failure is
// hidden and the consumer runs on empty input. Capture the output instead:
//   out=$(producer) && printf '%s\n' "$out" | consumer
import { readFileSync, readdirSync, existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { safeCommands, unguardedPipes } from "./package-scripts.mts"

const root = resolve(import.meta.dirname, "..")

function workspaceDirs(): string[] {
  const yaml = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8")
  const globs = [...yaml.matchAll(/^\s+-\s+"?([\w./-]+)\/\*"?\s*$/gm)].map(
    (m) => m[1]
  )
  return globs.flatMap((parent) => {
    const dir = join(root, parent)
    if (!existsSync(dir)) return []
    return readdirSync(dir).map((name) => join(dir, name))
  })
}

const packages = [root, ...workspaceDirs()]
  .map((dir) => join(dir, "package.json"))
  .filter((file) => existsSync(file))
const offenders: string[] = []

for (const file of packages) {
  const scripts: Record<string, string> =
    JSON.parse(readFileSync(file, "utf8")).scripts ?? {}
  for (const [name, command] of Object.entries(scripts)) {
    for (const pipeline of unguardedPipes(command))
      offenders.push(`${file} "${name}": ${pipeline}`)
  }
}

if (offenders.length > 0) {
  console.error(
    `Pipes hide the producer's failure in npm scripts (sh has no pipefail). Only ${safeCommands.join(" or ")} may feed a pipe; capture anything else first:\n  out=$(producer) && printf '%s\\n' "$out" | consumer\n${offenders.join("\n")}`
  )
  process.exit(1)
}
console.log(
  `Checked ${packages.length} package.json files, no unguarded pipes.`
)
