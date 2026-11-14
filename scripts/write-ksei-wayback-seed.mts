// `pnpm ksei:wayback-seed`: rewrites the Deep backfill's seed from the
// Wayback Machine's CDX index (ksei-wayback-seed.mts).
import { Console, Effect, FileSystem, Path } from "effect"
import { FetchHttpClient } from "effect/http"

import {
  CDX_URLS,
  fetchCdx,
  SEED_PATH,
  seedFilenames,
  seedModule,
} from "./ksei-wayback-seed.mts"
import { repoRoot } from "./lib/check.mts"
import { runScript } from "./lib/run.mts"

runScript(
  Effect.gen(function* () {
    const answers = yield* Effect.forEach(CDX_URLS, fetchCdx)
    const names = yield* seedFilenames(answers)
    const path = (yield* Path.Path).join(yield* repoRoot, SEED_PATH)
    yield* (yield* FileSystem.FileSystem).writeFileString(
      path,
      yield* seedModule(names)
    )
    yield* Console.log(`Wrote ${names.length} filenames to ${SEED_PATH}`)
  }).pipe(Effect.provide(FetchHttpClient.layer))
)
