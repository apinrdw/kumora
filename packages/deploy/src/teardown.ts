// The GitHub teardown job (.github/workflows/teardown-preview.yml):
//   bun packages/deploy/src/teardown.ts stage <branch>   prints stage=<stage>
//   bun packages/deploy/src/teardown.ts destroy <stage>  destroys every app
import { runAlchemy } from "./alchemy-cli.ts"
import {
  APPS,
  isPreview,
  parseStage,
  stageForBranch,
  type Preview,
  type Stage,
} from "./target.ts"

function preview(stage: Stage): Preview {
  if (!isPreview(stage))
    throw new Error(`Refusing to tear down stage "${stage}": not a preview.`)
  return stage
}

async function destroy(stage: Preview): Promise<void> {
  for (const app of APPS) {
    const code = await runAlchemy(app, ["destroy", "--stage", stage])
    if (code !== 0) process.exit(code)
  }
}

const [command, arg = ""] = process.argv.slice(2)

if (command === "stage") {
  console.log(`stage=${preview(stageForBranch(arg))}`)
} else if (command === "destroy") {
  await destroy(preview(parseStage(arg)))
} else {
  throw new Error(`Expected "stage <branch>" or "destroy <stage>".`)
}
