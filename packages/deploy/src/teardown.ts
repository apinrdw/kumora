// The GitHub teardown job (.github/workflows/teardown-preview.yml):
//   bun packages/deploy/src/teardown.ts stage <branch>   prints stage=<stage>
//   bun packages/deploy/src/teardown.ts destroy <stage>  destroys every app
import { Command } from "effect/cli"

import { runMain } from "./run.ts"
import { teardownCommand } from "./teardown-command.ts"

runMain(Command.run(teardownCommand, { version: "0.0.0" }))
