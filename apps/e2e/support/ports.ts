import { APPS, DEV_PORT_VARIABLES, devPort } from "@workspace/deploy"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { execFileSync } from "node:child_process"

// Ports the OS has free, found in a child process: listening is asynchronous,
// and every module that builds a test URL needs them while it loads.
const FREE_PORTS = (count: number) => `
const net = require("node:net")
const ports = []
for (let i = 0; i < ${count}; i++) {
  const server = net.createServer().listen(0, "localhost", () => {
    ports.push(server.address().port)
    if (ports.length === ${count}) process.stdout.write(ports.join(" "))
    server.unref()
  })
}
`

/**
 * Gives each app of this e2e run a free port, once, where
 * playwright.config.ts first loads this, and keeps them in the environment,
 * so the dev servers (through turbo's dev passThroughEnv) and every test
 * worker read the same ones (packages/deploy/src/target.ts devPort). A port
 * already set stays, once devPort itself accepts it, so devPort cannot fail
 * later on it.
 */
const unset = APPS.filter((app) => {
  const variable = DEV_PORT_VARIABLES[app]
  const value = process.env[variable]
  if (!value) return true
  // A provider of its own: the default one copies the environment on first
  // use, which here would be before the free ports below are set.
  const check = devPort(app).pipe(
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromEnv()
    )
  )
  if (Exit.isFailure(Effect.runSyncExit(check)))
    throw new Error(
      `${variable}=${JSON.stringify(value)} is not a port. Set it to an integer from 1 to 65535, or unset it for a free port.`
    )
  return false
})
if (unset.length > 0) {
  const ports = execFileSync(
    process.execPath,
    ["-e", FREE_PORTS(unset.length)],
    {
      encoding: "utf8",
    }
  ).split(" ")
  unset.forEach((app, i) => {
    process.env[DEV_PORT_VARIABLES[app]] = ports[i]
  })
}
