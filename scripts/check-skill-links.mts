// Fails when a relative markdown link in AGENTS.md or a skill file points at a missing path.
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    return statSync(full).isDirectory()
      ? walk(full)
      : name.endsWith(".md")
        ? [full]
        : []
  })
}

const files = [
  join(root, "AGENTS.md"),
  ...walk(join(root, ".claude", "skills")),
]
const linkPattern = /\[[^\]]*\]\(([^)\s#]+)(?:#[^)]*)?\)/g
const broken = []

for (const file of files) {
  const text = readFileSync(file, "utf8")
  for (const match of text.matchAll(linkPattern)) {
    const target = match[1]
    if (/^[a-z]+:/i.test(target)) continue
    const path = resolve(dirname(file), target)
    if (!existsSync(path)) broken.push(`${file}: ${target}`)
  }
}

if (broken.length > 0) {
  console.error(`Broken links:\n${broken.join("\n")}`)
  process.exit(1)
}
console.log(`Checked ${files.length} files, all links resolve.`)
