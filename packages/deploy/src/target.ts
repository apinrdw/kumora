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

export const PRODUCTION = "production" as Stage
export const STAGING = "staging" as Stage
export const TEST_STAGE = "test" as Stage

const MAX_WORKER_NAME = 54
// The longest app prefix, `kumora-dashboard-`, plus `-` and the hash, leaves 30.
const MAX_SLUG = 30
const HASH_LENGTH = 6
const PREVIEW = /^(?:[a-z0-9](?:[-a-z0-9]*[a-z0-9])?-)?[0-9a-f]{6}$/
const DEV = /^dev_[-_a-z0-9]+$/i

// Decision: the newest date the workerd bundled with alchemy accepts, not today's.
// Re-check it on every `alchemy` bump: local dev and the deployed Worker must agree.
// It replaces the date limit that wrangler.jsonc recorded. See apinrdw/kumora#19.
export const COMPATIBILITY_DATE = "2026-10-26"

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

export function stageKind(stage: Stage): StageKind {
  if (stage === PRODUCTION) return "production"
  if (stage === STAGING) return "staging"
  if (stage === TEST_STAGE) return "test"
  if (DEV.test(stage)) return "dev"
  return "preview"
}

// Alchemy hands a stack any stage name. Anything that no branch, dev or test
// stage could produce (alchemy's `live_$USER` default) is refused here.
export function parseStage(raw: string): Stage {
  if (
    raw === PRODUCTION ||
    raw === STAGING ||
    raw === TEST_STAGE ||
    DEV.test(raw) ||
    PREVIEW.test(raw)
  )
    return raw as Stage
  throw new Error(
    `Unknown stage "${raw}". Deploy through packages/deploy (production, staging, a branch preview, dev_$USER or test).`
  )
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
    infisicalEnvironment:
      kind === "production" ? "prod" : kind === "test" ? undefined : "staging",
    stateStore: kind === "dev" || kind === "test" ? "local" : "cloudflare",
  }
}

export function deployTarget(app: App, branch: string): DeployTarget {
  return stageTarget(app, stageForBranch(branch))
}
