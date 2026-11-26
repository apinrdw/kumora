import config from "../vite.config.ts"
import { runScript } from "./lib/run.mts"
import { checkOxlintOverrides } from "./oxlint-overrides.mts"

runScript(checkOxlintOverrides(config.lint))
