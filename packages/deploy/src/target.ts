import { createHash } from "node:crypto"

import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

export const APPS = ["web", "dashboard"] as const
export type App = (typeof APPS)[number]

export type StageKind = "production" | "staging" | "preview" | "dev" | "test"
export type InfisicalEnvironment = "prod" | "staging"
export type StateStore = "cloudflare" | "local"

const PRODUCTION = "production"
const STAGING = "staging"
// apps/e2e/playwright.config.ts sets ALCHEMY_STAGE to this name.
const TEST = "test"

const MAX_WORKER_NAME = 54
// The longest app prefix, `kumora-dashboard-`, plus `-` and the hash, leaves 30.
const MAX_SLUG = 30
const HASH_LENGTH = 6
const PREVIEW = new RegExp(
  `^(?:[a-z0-9](?:[-a-z0-9]*[a-z0-9])?-)?[0-9a-f]{${HASH_LENGTH}}$`
)
const DEV = /^dev_[-_a-z0-9]+$/i

const classify = Effect.fnUntraced(function* (
  raw: string
): Effect.fn.Return<StageKind | undefined> {
  if (raw === PRODUCTION) return "production"
  if (raw === STAGING) return "staging"
  if (raw === TEST) return "test"
  if (DEV.test(raw)) return "dev"
  if (PREVIEW.test(raw)) return "preview"
  return undefined
})

// Alchemy hands a stack any stage name. Anything that no branch, dev or test
// stage could produce (alchemy's `live_$USER` default) is not a Stage.
// Schema calls a filter synchronously, and classify is pure, so the filters
// runSync it.
export const Stage = Schema.String.check(
  Schema.makeFilter((raw) => Effect.runSync(classify(raw)) !== undefined)
).pipe(Schema.brand("Stage"))
export type Stage = typeof Stage.Type

export const Preview = Stage.check(
  Schema.makeFilter((stage) => Effect.runSync(classify(stage)) === "preview")
).pipe(Schema.brand("Preview"))
export type Preview = typeof Preview.Type

export const isPreview = Schema.is(Preview)

export class UnknownStage extends Schema.TaggedError<UnknownStage>()(
  "UnknownStage",
  { stage: Schema.String }
) {
  override get message() {
    return `Unknown stage "${this.stage}". Deploy through packages/deploy (production, staging, a branch preview, dev_$USER or test).`
  }
}

export interface DeployTarget {
  readonly stage: Stage
  readonly workerName: string
  // Undefined on the test stage, which reads only the process environment.
  readonly infisicalEnvironment: InfisicalEnvironment | undefined
  readonly stateStore: StateStore
}

// Decision: the newest date the workerd bundled with alchemy accepts, not today's,
// so local dev and the deployed Worker agree. Re-check on every `alchemy` bump:
// set a far-future date, run `bun alchemy dev`, and read "the newest date
// supported by this server binary". See apinrdw/kumora#19.
export const COMPATIBILITY_DATE = "2026-11-02"

export const parseStage = Effect.fnUntraced(function* (
  raw: string
): Effect.fn.Return<Stage, UnknownStage> {
  return yield* Schema.decodeEffect(Stage)(raw).pipe(
    Effect.mapError(() => new UnknownStage({ stage: raw }))
  )
})

// Every branch name maps to a Stage, so a refusal here is a bug.
export const stageForBranch = Effect.fnUntraced(function* (
  branch: string
): Effect.fn.Return<Stage> {
  if (branch === "main") return yield* Effect.orDie(parseStage(PRODUCTION))
  if (branch === "staging") return yield* Effect.orDie(parseStage(STAGING))
  const hash = createHash("sha256")
    .update(branch)
    .digest("hex")
    .slice(0, HASH_LENGTH)
  const slug = branch
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+/, "")
    .slice(0, MAX_SLUG)
    .replace(/-+$/, "")
  return yield* Effect.orDie(parseStage(slug ? `${slug}-${hash}` : hash))
})

export const devStage = Effect.fnUntraced(function* (
  user: string
): Effect.fn.Return<Stage, UnknownStage> {
  return yield* parseStage(`dev_${user}`)
})

const KINDS: Record<
  StageKind,
  Pick<DeployTarget, "infisicalEnvironment" | "stateStore">
> = {
  production: { infisicalEnvironment: "prod", stateStore: "cloudflare" },
  staging: { infisicalEnvironment: "staging", stateStore: "cloudflare" },
  preview: { infisicalEnvironment: "staging", stateStore: "cloudflare" },
  dev: { infisicalEnvironment: "staging", stateStore: "local" },
  test: { infisicalEnvironment: undefined, stateStore: "local" },
}

// The Stage schema admits only names that classify, so a miss is a bug.
export const stageKind = Effect.fnUntraced(function* (
  stage: Stage
): Effect.fn.Return<StageKind> {
  return yield* Effect.orDie(Effect.fromNullishOr(yield* classify(stage)))
})

export const stageTarget = Effect.fnUntraced(function* (
  app: App,
  stage: Stage
): Effect.fn.Return<DeployTarget> {
  const kind = yield* stageKind(stage)
  return {
    stage,
    workerName:
      kind === "production"
        ? `kumora-${app}`
        : `kumora-${app}-${stage.toLowerCase().replaceAll("_", "-")}`.slice(
            0,
            MAX_WORKER_NAME
          ),
    ...KINDS[kind],
  }
})

export const deployTarget = Effect.fnUntraced(function* (
  app: App,
  branch: string
): Effect.fn.Return<DeployTarget> {
  return yield* stageTarget(app, yield* stageForBranch(branch))
})
