// The Workers Builds deploy and preview command, run from apps/<app>:
//   bun ../../packages/deploy/src/deploy.ts <app>
import { Command } from "effect/cli"

import { deployCommand } from "./deploy-command.ts"
import { runMain } from "./run.ts"

runMain(Command.run(deployCommand, { version: "0.0.0" }))
