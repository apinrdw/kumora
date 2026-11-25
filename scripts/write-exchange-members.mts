// `pnpm idx:exchange-members`: rewrites the dashboard's exchange-member table
// from IDX's list (exchange-members.mts).
import { Console, Effect, FileSystem, Path } from "effect"
import { FetchHttpClient } from "effect/http"

import {
  fetchMembers,
  MEMBERS_PATH,
  membersModule,
} from "./exchange-members.mts"
import { repoRoot } from "./lib/check.mts"
import { runScript } from "./lib/run.mts"

runScript(
  Effect.gen(function* () {
    const members = yield* fetchMembers()
    const path = (yield* Path.Path).join(yield* repoRoot, MEMBERS_PATH)
    yield* (yield* FileSystem.FileSystem).writeFileString(
      path,
      yield* membersModule(members)
    )
    yield* Console.log(
      `Wrote ${members.data.length} members to ${MEMBERS_PATH}`
    )
  }).pipe(Effect.provide(FetchHttpClient.layer))
)
