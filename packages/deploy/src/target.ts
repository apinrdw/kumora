import { createHash } from "node:crypto"

import { DashboardBasePath } from "@workspace/client/base-path"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

export const APPS = ["web", "dashboard"] as const
export type App = (typeof APPS)[number]

export type StageKind = "production" | "staging" | "preview" | "dev" | "test"
export type InfisicalEnvironment = "prod" | "staging"
export type StateStore = "cloudflare" | "local"

const PRODUCTION = "production"
const STAGING = "staging"
// The Stage e2e runs on: apps/e2e/playwright.config.ts sets ALCHEMY_STAGE to it.
const TEST_NAME = "test"

// The variables that move each app's dev server port. turbo.json's dev
// passThroughEnv repeats both names, so a rename here goes there too.
export const DEV_PORT_VARIABLES = {
  web: "KUMORA_WEB_PORT",
  dashboard: "KUMORA_DASHBOARD_PORT",
} as const satisfies Record<App, string>
// Each app's dev server port under `alchemy dev` when its variable is unset.
// Each alchemy.run.ts makes its port strict, so one app never takes the
// other's.
const DEFAULT_DEV_PORTS = {
  web: 3000,
  dashboard: 3001,
} as const satisfies Record<App, number>

export const devPort = (app: App): Effect.Effect<number> =>
  Config.Port(DEV_PORT_VARIABLES[app]).pipe(
    // Decision: a dev port is its app's variable, else the default; e2e picks free
    // (packages/deploy/docs/adr/0004-a-dev-port-is-its-app-s-variable-and-e2e-picks-free-ports.md)
    Config.withDefault(DEFAULT_DEV_PORTS[app]),
    Effect.orDie
  )

// An app's Alchemy stack, also its Production Worker. Local state lives under
// `.alchemy/state/<stack>/<stage>/`.
export const stackName = Effect.fnUntraced(function* (
  app: App
): Effect.fn.Return<string> {
  return `kumora-${app}`
})

// The account's workers.dev subdomain. docs/runbooks/deploy.md, "Checking a
// stage", curls the same host, and its sections 9.5 and 10.1 send the auth
// mail check and Google's redirect URIs to the URL built from it.
const WORKERS_DEV_SUBDOMAIN = "kumora"

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
  if (raw === TEST_NAME) return "test"
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

// The newest date the workerd bundled with alchemy accepts, not today's,
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

// The test stage as a Stage, for e2e. classify accepts its name, so parsing
// it cannot fail.
export const TEST: Stage = Effect.runSync(Effect.orDie(parseStage(TEST_NAME)))

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

// Production and Staging: the stages with a fixed URL that outside services
// (an OAuth client, a Turnstile widget) are set up for.
export const isReleaseStage = Effect.fnUntraced(function* (
  stage: Stage
): Effect.fn.Return<boolean> {
  const kind = yield* stageKind(stage)
  return kind === "production" || kind === "staging"
})

export const stageTarget = Effect.fnUntraced(function* (
  app: App,
  stage: Stage
): Effect.fn.Return<DeployTarget> {
  const kind = yield* stageKind(stage)
  const stack = yield* stackName(app)
  const suffix = stage.toLowerCase().replaceAll("_", "-")
  return {
    stage,
    workerName:
      kind === "production"
        ? stack
        : `${stack}-${suffix}`.slice(0, MAX_WORKER_NAME),
    ...KINDS[kind],
  }
})

// The path each app is served under on its host: web at the root, the
// dashboard at its base path.
const APP_PATHS = {
  web: "",
  dashboard: DashboardBasePath,
} as const satisfies Record<App, string>

// An app's Stage URL (GLOSSARY.md): its Worker's workers.dev URL, or the app's
// dev server on Dev and Test stages, which run only under `alchemy dev`, plus
// the path the app is served under. It may carry a path, so a caller that
// needs only the host or origin reads it from `new URL(...)`.
// Decision: the dashboard is served under /dashboard on every Stage
// (docs/adr/0020-the-dashboard-is-served-under-dashboard-on-every-stage.md)
export const stageUrl = Effect.fnUntraced(function* (
  app: App,
  stage: Stage
): Effect.fn.Return<string> {
  const kind = yield* stageKind(stage)
  if (kind === "dev" || kind === "test")
    return `http://localhost:${yield* devPort(app)}${APP_PATHS[app]}`
  const { workerName } = yield* stageTarget(app, stage)
  return `https://${workerName}.${WORKERS_DEV_SUBDOMAIN}.workers.dev${APP_PATHS[app]}`
})

export const deployTarget = Effect.fnUntraced(function* (
  app: App,
  branch: string
): Effect.fn.Return<DeployTarget> {
  return yield* stageTarget(app, yield* stageForBranch(branch))
})
