import { createHash } from "node:crypto"

export const APPS = ["web", "dashboard"] as const
export type App = (typeof APPS)[number]

export type Stage = string & { readonly __brand: "Stage" }
export type Preview = Stage & { readonly __preview: true }
export type StageKind = "production" | "staging" | "preview" | "dev" | "test"
export type InfisicalEnvironment = "prod" | "staging"
export type StateStore = "cloudflare" | "local"

export interface DeployTarget {
  readonly stage: Stage
  readonly workerName: string
  // Undefined on the test stage, which reads only the process environment.
  readonly infisicalEnvironment: InfisicalEnvironment | undefined
  readonly stateStore: StateStore
}

const PRODUCTION = "production" as Stage
const STAGING = "staging" as Stage
// The Stage e2e runs on: apps/e2e/playwright.config.ts sets ALCHEMY_STAGE to it.
export const TEST = "test" as Stage

// Each app's dev server port under `alchemy dev`, strict so one app never
// takes the other's. e2e waits on both.
export const DEV_PORTS = {
  web: 3000,
  dashboard: 3001,
} as const satisfies Record<App, number>

// An app's Alchemy stack, also its Production Worker. Local state lives under
// `.alchemy/state/<stack>/<stage>/`.
export function stackName(app: App): string {
  return `kumora-${app}`
}

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

// Decision: the newest date the workerd bundled with alchemy accepts, not today's,
// so local dev and the deployed Worker agree. Re-check on every `alchemy` bump:
// set a far-future date, run `bun alchemy dev`, and read "the newest date
// supported by this server binary". See apinrdw/kumora#19.
export const COMPATIBILITY_DATE = "2026-11-02"

export function stageForBranch(branch: string): Stage {
  if (branch === "main") return PRODUCTION
  if (branch === "staging") return STAGING
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
  return (slug ? `${slug}-${hash}` : hash) as Stage
}

export function devStage(user: string): Stage {
  return parseStage(`dev_${user}`)
}

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

function classify(raw: string): StageKind | undefined {
  if (raw === PRODUCTION) return "production"
  if (raw === STAGING) return "staging"
  if (raw === TEST) return "test"
  if (DEV.test(raw)) return "dev"
  if (PREVIEW.test(raw)) return "preview"
  return undefined
}

// Alchemy hands a stack any stage name. Anything that no branch, dev or test
// stage could produce (alchemy's `live_$USER` default) is refused here.
export function parseStage(raw: string): Stage {
  if (classify(raw) === undefined)
    throw new Error(
      `Unknown stage "${raw}". Deploy through packages/deploy (production, staging, a branch preview, dev_$USER or test).`
    )
  return raw as Stage
}

export function stageKind(stage: Stage): StageKind {
  // Every Stage was parsed or built by stageForBranch, so it classifies.
  return classify(stage) as StageKind
}

// Production and Staging: the stages with a fixed URL that outside services
// (an OAuth client, a Turnstile widget) are set up for.
export function isReleaseStage(stage: Stage): boolean {
  const kind = stageKind(stage)
  return kind === "production" || kind === "staging"
}

export function isPreview(stage: Stage): stage is Preview {
  return stageKind(stage) === "preview"
}

export function stageTarget(app: App, stage: Stage): DeployTarget {
  const kind = stageKind(stage)
  const suffix = stage.toLowerCase().replaceAll("_", "-")
  return {
    stage,
    workerName:
      kind === "production"
        ? stackName(app)
        : `${stackName(app)}-${suffix}`.slice(0, MAX_WORKER_NAME),
    ...KINDS[kind],
  }
}

// Where a stage's Worker serves: its workers.dev URL, or the app's dev server
// on Dev and Test stages, which run only under `alchemy dev`.
export function stageUrl(app: App, stage: Stage): string {
  const kind = stageKind(stage)
  if (kind === "dev" || kind === "test")
    return `http://localhost:${DEV_PORTS[app]}`
  const { workerName } = stageTarget(app, stage)
  return `https://${workerName}.${WORKERS_DEV_SUBDOMAIN}.workers.dev`
}

export function deployTarget(app: App, branch: string): DeployTarget {
  return stageTarget(app, stageForBranch(branch))
}
