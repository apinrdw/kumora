import { createHash } from "node:crypto"

export const APPS = ["web", "dashboard"] as const
export type App = (typeof APPS)[number]

export type Stage = string & { readonly __brand: "Stage" }
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
  if (raw === "test") return "test"
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

export function stageTarget(app: App, stage: Stage): DeployTarget {
  const kind = stageKind(stage)
  const suffix = stage.toLowerCase().replaceAll("_", "-")
  return {
    stage,
    workerName:
      kind === "production"
        ? `kumora-${app}`
        : `kumora-${app}-${suffix}`.slice(0, MAX_WORKER_NAME),
    ...KINDS[kind],
  }
}

export function deployTarget(app: App, branch: string): DeployTarget {
  return stageTarget(app, stageForBranch(branch))
}
