// Two copies of Effect break Context.Service and Schema.TaggedError identity,
// and repos/effect and repos/alchemy track the same versions, so the Effect and
// Alchemy pins live once, in the pnpm-workspace.yaml catalog.
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
