// Fails when a setup-vp step or the Workers Builds installer names a vp
// version other than the root vite-plus devDependency, so a vite-plus bump
// can't leave CI or deploys on an older vp.
import { Effect } from "effect"

import { repoRoot } from "./lib/check.mts"
import { runScript } from "./lib/run.mts"
import { checkVpVersion } from "./vp-version.mts"

runScript(Effect.flatMap(repoRoot, checkVpVersion))
