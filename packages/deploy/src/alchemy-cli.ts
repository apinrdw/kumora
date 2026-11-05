import { spawn } from "node:child_process"
import { resolve } from "node:path"

import { APPS, type App } from "./target.ts"

export function parseApp(raw: string | undefined): App {
  const app = APPS.find((a) => a === raw)
  if (app === undefined)
    throw new Error(`Expected an app (${APPS.join(", ")}), got "${raw}".`)
  return app
}

export function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set.`)
  return value
}

// Runs the app's own alchemy CLI in its folder, where its alchemy.run.ts lives.
export function runAlchemy(
  app: App,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv = process.env
): Promise<number> {
  const child = spawn("bun", ["alchemy", ...args, "--yes"], {
    cwd: resolve(import.meta.dirname, "../../../apps", app),
    env,
    stdio: "inherit",
  })
  return new Promise((done, fail) => {
    child.on("error", fail)
    child.on("exit", (code) => done(code ?? 1))
  })
}
