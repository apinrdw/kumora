// Enforces the catalog Decision in pnpm-workspace.yaml.
import { NodeServices } from "@effect/platform-node"
import { assert, layer } from "@effect/vitest"
import { Effect, FileSystem, Path, Schema } from "effect"

import { stdoutOf } from "./lib/command.mts"

const pinned = /^(effect|@effect\/.+|alchemy|@alchemy\.run\/.+)$/
const dependencyFields = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const

const Dependencies = Schema.optional(
  Schema.Record(Schema.String, Schema.String)
)
const Manifest = Schema.fromJsonString(
  Schema.Struct({
    dependencies: Dependencies,
    devDependencies: Dependencies,
    peerDependencies: Dependencies,
    optionalDependencies: Dependencies,
  })
)
const Projects = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ path: Schema.String }))
)

const workspaceProjects = Effect.gen(function* () {
  const path = yield* Path.Path
  const root = path.resolve(import.meta.dirname, "..")
  const listed = yield* stdoutOf(
    "pnpm",
    ["ls", "-r", "--depth", "-1", "--json"],
    { cwd: root }
  )
  const projects = yield* Schema.decodeEffect(Projects)(listed)
  return { root, dirs: projects.map((project) => project.path) }
})

// In-process deploys import the app stacks from packages/deploy, so a second
// alchemy or effect copy (a peer variant) would split their services.
const singleCopy = ["alchemy", "effect"]

// "a@1(b@2(c@3))(d@4)" -> ["(b@2(c@3))", "(d@4)"]
const peerGroups = (key: string): string[] => {
  const groups: string[] = []
  let depth = 0
  let start = 0
  for (const [i, ch] of [...key].entries()) {
    if (ch === "(" && depth++ === 0) start = i
    if (ch === ")" && --depth === 0) groups.push(key.slice(start, i + 1))
  }
  return groups
}

const snapshotSplits = Effect.fnUntraced(function* (lockfile: string) {
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
})

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

layer(NodeServices.layer)("catalog pins", (it) => {
  it.effect("pnpm lists the workspace projects", () =>
    Effect.gen(function* () {
      const { root, dirs } = yield* workspaceProjects
      assert.include(dirs, root)
    })
  )

  it.effect("every Effect and Alchemy dependency comes from the catalog", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const { root, dirs } = yield* workspaceProjects
      const uncataloged = yield* Effect.forEach(dirs, (dir) =>
        Effect.gen(function* () {
          const manifest = yield* Schema.decodeEffect(Manifest)(
            yield* fs.readFileString(path.join(dir, "package.json"))
          )
          return dependencyFields.flatMap((field) =>
            Object.entries(manifest[field] ?? {})
              .filter(
                ([name, spec]) =>
                  pinned.test(name) && !spec.startsWith("catalog:")
              )
              .map(
                ([name, spec]) =>
                  `${path.relative(root, dir) || "."} ${field} ${name}: ${spec}`
              )
          )
        })
      )
      assert.deepStrictEqual(uncataloged.flat(), [])
    })
  )

  it.effect("the lockfile holds one alchemy and one effect snapshot", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const lockfile = yield* fs.readFileString(
        path.resolve(import.meta.dirname, "../pnpm-lock.yaml")
      )
      assert.deepStrictEqual(yield* snapshotSplits(lockfile), [])
    })
  )

  it.effect(
    "two alchemy snapshots are reported with the peers that differ",
    () =>
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* snapshotSplits(twoAlchemySnapshots), [
          "pnpm-lock.yaml holds 2 alchemy@ snapshots whose peers differ: (ws@8.22.0) vs (ws@8.22.1). Run `pnpm dedupe`.",
        ])
      })
  )
})
