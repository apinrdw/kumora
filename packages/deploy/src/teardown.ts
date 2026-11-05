// The GitHub teardown job (.github/workflows/teardown-preview.yml):
//   bun packages/deploy/src/teardown.ts stage <branch>   prints stage=<stage>
//   bun packages/deploy/src/teardown.ts destroy <stage>  destroys every app
import { runAlchemy } from "./alchemy-cli.ts"
import {
  APPS,
  parseStage,
  stageForBranch,
  stageKind,
  type Stage,
} from "./target.ts"

function preview(stage: Stage): Stage {
  if (stageKind(stage) !== "preview")
    throw new Error(`Refusing to tear down stage "${stage}": not a preview.`)
  return stage
}

const [command, arg = ""] = process.argv.slice(2)

if (command === "stage") {
  console.log(`stage=${preview(stageForBranch(arg))}`)
} else if (command === "destroy") {
  const stage = preview(parseStage(arg))
  for (const app of APPS) {
    const code = await runAlchemy(app, ["destroy", "--stage", stage])
    if (code !== 0) process.exit(code)
  }
} else {
  throw new Error(`Expected "stage <branch>" or "destroy <stage>".`)
}
