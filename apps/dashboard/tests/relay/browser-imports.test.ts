import { existsSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"

// ADR-0002 keeps Effect behind the server-function seam. The live page bundles these
// relay modules into the browser, so nothing they import, however deep, may be `effect`.
const SRC = fileURLToPath(new URL("../../src/", import.meta.url))
const BROWSER_ROOTS = ["features/radar/chart-slots.ts"]

const VALUE_IMPORT = /^import\s+(?!type\b)[^"]*?"([^"]+)"/gm

const fileOf = (specifier: string, from: string): string | undefined => {
  const base = specifier.startsWith("@/")
    ? resolve(SRC, specifier.slice(2))
    : resolve(dirname(from), specifier)
  return [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find(existsSync)
}

const packagesReachedFrom = (root: string): ReadonlySet<string> => {
  const packages = new Set<string>()
  const seen = new Set<string>()
  const visit = (file: string) => {
    if (seen.has(file)) return
    seen.add(file)
    for (const [, specifier = ""] of readFileSync(file, "utf8").matchAll(
      VALUE_IMPORT
    )) {
      const local = specifier.startsWith(".") || specifier.startsWith("@/")
      if (!local) packages.add(specifier.split("/")[0] ?? specifier)
      else {
        const next = fileOf(specifier, file)
        if (next) visit(next)
        else throw new Error(`${file}: cannot resolve ${specifier}`)
      }
    }
  }
  visit(resolve(SRC, root))
  return packages
}

describe("modules the browser bundles", () => {
  test.each(BROWSER_ROOTS)("%s reaches no effect", (root) => {
    expect([...packagesReachedFrom(root)]).not.toContain("effect")
  })
})
