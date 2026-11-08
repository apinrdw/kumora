// Fails when a relative markdown link in AGENTS.md or a skill file points at a missing path.
import { Console, Effect, FileSystem, Path } from "effect"

import { CheckFailed } from "./lib/check.mts"

const linkPattern = /\[[^\]]*\]\(([^)\s#]+)(?:#[^)]*)?\)/g

export const checkSkillLinks = Effect.fn("checkSkillLinks")(function* (
  root: string
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const skills = path.join(root, ".claude", "skills")
  const skillFiles = (yield* fs.exists(skills))
    ? (yield* fs.readDirectory(skills, { recursive: true }))
        .filter((name) => name.endsWith(".md"))
        .map((name) => path.join(skills, name))
    : []
  const files = [path.join(root, "AGENTS.md"), ...skillFiles]
  const broken = yield* Effect.forEach(files, (file) =>
    Effect.gen(function* () {
      const text = yield* fs.readFileString(file)
      const targets = [...text.matchAll(linkPattern)]
        .map(([, target]) => target as string)
        .filter((target) => !/^[a-z]+:/i.test(target))
      const missing = yield* Effect.filter(targets, (target) =>
        Effect.map(
          fs.exists(path.resolve(path.dirname(file), target)),
          (exists) => !exists
        )
      )
      return missing.map((target) => `${path.relative(root, file)}: ${target}`)
    })
  )
  if (broken.flat().length > 0)
    return yield* new CheckFailed({
      summary: "Broken links:",
      findings: broken.flat(),
    })
  yield* Console.log(`Checked ${files.length} files, all links resolve.`)
})
