// Fails when an ADR directory or a path into one is back in the repo.
// Decisions are `Decision:` comments in code; see docs/agents/domain.md.
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")
const files = execFileSync(
  "git",
  // repos/ is vendored upstream source, which may keep ADRs of its own.
  [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "--",
    ":(exclude)repos",
  ],
  { cwd: root, encoding: "utf8" }
)
  .split("\n")
  .filter(Boolean)

const adrDir = /(^|\/)adrs?\//i
const findings = []

for (const file of files) {
  if (adrDir.test(file)) {
    findings.push(`${file}: lives in an ADR directory`)
    continue
  }
  let text
  try {
    text = readFileSync(resolve(root, file), "utf8")
  } catch {
    continue
  }
  if (text.includes("\0")) continue
  text.split("\n").forEach((line, index) => {
    if (/docs\/adrs?\//i.test(line)) {
      findings.push(`${file}:${index + 1}: points into an ADR directory`)
    }
  })
}

if (findings.length > 0) {
  console.error(
    `This repo keeps decisions as \`Decision:\` comments, not ADRs (docs/agents/domain.md):\n${findings.join("\n")}`
  )
  process.exit(1)
}
console.log(`Checked ${files.length} files, no ADRs.`)
