import { APPS, DEV_PORT_VARIABLES } from "@workspace/deploy"
import { execFileSync } from "node:child_process"

// Ports the OS has free, found in a child process: listening is asynchronous,
// and every module that builds a test URL needs them while it loads.
const FREE_PORTS = `
const net = require("node:net")
const servers = ${APPS.length}
const ports = []
for (let i = 0; i < servers; i++) {
  const server = net.createServer().listen(0, "localhost", () => {
    ports.push(server.address().port)
    if (ports.length === servers) process.stdout.write(ports.join(" "))
    server.unref()
  })
}
`

/**
 * Gives each app of this e2e run a free port, once, where
 * playwright.config.ts first loads this, and keeps them in the environment,
 * so the dev servers (through turbo's dev passThroughEnv) and every test
 * worker read the same ones (packages/deploy/src/target.ts devPort).
 */
if (APPS.some((app) => !process.env[DEV_PORT_VARIABLES[app]])) {
  const ports = execFileSync(process.execPath, ["-e", FREE_PORTS], {
    encoding: "utf8",
  }).split(" ")
  APPS.forEach((app, i) => {
    process.env[DEV_PORT_VARIABLES[app]] = ports[i]
  })
}
