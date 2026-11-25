// Resolves `@/` to src/ in a worker thread, which runs in plain Node outside
// Vitest's aliases: the `@/*` path of apps/dashboard/tsconfig.json, which
// names this file. A worker imports it first, before any module that uses
// `@/`.
import { registerHooks } from "node:module"

const SRC = new URL("../../../src/", import.meta.url)

registerHooks({
  resolve: (specifier, context, next) =>
    next(
      specifier.startsWith("@/")
        ? new URL(`${specifier.slice(2)}.ts`, SRC).href
        : specifier,
      context
    ),
})
