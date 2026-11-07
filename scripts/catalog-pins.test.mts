// Enforces the catalog Decision in pnpm-workspace.yaml.
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { test } from "node:test"
import assert from "node:assert/strict"

const root = resolve(import.meta.dirname, "..")
const pinned = /^(effect|@effect\/.+|alchemy|@alchemy\.run\/.+)$/
const dependencyFields = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
]

const listed = spawnSync("pnpm", ["ls", "-r", "--depth", "-1", "--json"], {
  cwd: root,
  encoding: "utf8",
})
const projectDirs: ReadonlyArray<string> =
  listed.status === 0
    ? JSON.parse(listed.stdout).map((project: { path: string }) => project.path)
    : []

test("pnpm lists the workspace projects", () => {
  assert.equal(listed.status, 0, listed.stderr)
  assert.ok(projectDirs.includes(root))
})

test("every Effect and Alchemy dependency comes from the catalog", () => {
  const uncataloged = projectDirs.flatMap((dir) => {
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))
    return dependencyFields.flatMap((field) =>
      Object.entries((manifest[field] ?? {}) as Record<string, string>)
        .filter(
          ([name, spec]) => pinned.test(name) && !spec.startsWith("catalog:")
        )
        .map(
          ([name, spec]) =>
            `${relative(root, dir) || "."} ${field} ${name}: ${spec}`
        )
    )
  })
  assert.deepEqual(uncataloged, [])
})

// In-process deploys import the app stacks from packages/deploy, so a second
// alchemy or effect copy (a peer variant) would split their services.
const singleCopy = ["alchemy", "effect"]

// "a@1(b@2(c@3))(d@4)" -> ["(b@2(c@3))", "(d@4)"]
function peerGroups(key: string): string[] {
  const groups: string[] = []
  let depth = 0
  let start = 0
  for (const [i, ch] of [...key].entries()) {
    if (ch === "(" && depth++ === 0) start = i
    if (ch === ")" && --depth === 0) groups.push(key.slice(start, i + 1))
  }
  return groups
}

function snapshotSplits(lockfile: string): string[] {
  const snapshots = lockfile.split(/^snapshots:$/m)[1] ?? ""
  const keys = [...snapshots.matchAll(/^ {2}'?([^\s'][^']*?)'?:/gm)].map(
    ([, key]) => key
  )
  return singleCopy.flatMap((name) => {
    const variants = keys
      .filter((key) => key.startsWith(`${name}@`))
      .map(peerGroups)
    if (variants.length < 2) return []
    const shared = variants.reduce((common, groups) =>
      common.filter((group) => groups.includes(group))
    )
    const differing = variants.map((groups) =>
      groups.filter((group) => !shared.includes(group)).join("")
    )
    return [
      `pnpm-lock.yaml holds ${variants.length} ${name}@ snapshots whose peers differ: ${differing.join(" vs ")}. Run \`pnpm dedupe\`.`,
    ]
  })
}

const twoAlchemySnapshots = `lockfileVersion: '9.0'

packages:

  alchemy@2.0.0-beta.85:
    resolution: {integrity: sha512-x}

snapshots:

  alchemy@2.0.0-beta.85(effect@4.1.2)(vite@8.3.4(yaml@2.9.1))(ws@8.22.0):
    dependencies:
      effect: 4.1.2

  alchemy@2.0.0-beta.85(effect@4.1.2)(vite@8.3.4(yaml@2.9.1))(ws@8.22.1):
    dependencies:
      effect: 4.1.2

  effect@4.1.2: {}
`

test("the lockfile holds one alchemy and one effect snapshot", () => {
  const lockfile = readFileSync(join(root, "pnpm-lock.yaml"), "utf8")
  assert.deepEqual(snapshotSplits(lockfile), [])
})

test("two alchemy snapshots are reported with the peers that differ", () => {
  assert.deepEqual(snapshotSplits(twoAlchemySnapshots), [
    "pnpm-lock.yaml holds 2 alchemy@ snapshots whose peers differ: (ws@8.22.0) vs (ws@8.22.1). Run `pnpm dedupe`.",
  ])
})
