import "./ports"

import { TEST, stageUrl, type App } from "@workspace/deploy"
import * as Effect from "effect/Effect"
import { fileURLToPath } from "node:url"

// Where an app serves on the Test stage. stageUrl's one input beyond its
// arguments is the port variables, which ./ports.ts fills or validates before
// any URL is built and nothing changes after, so the call is synchronous, has
// the same answer every time, and cannot fail: runSync.
export const testUrl = (app: App) => Effect.runSync(stageUrl(app, TEST))

export const DASHBOARD = testUrl("dashboard")

export interface SharedAccount {
  readonly name: string
  readonly email: string
  readonly password: string
  /** The signed-in browser state the setup project saves for the specs. */
  readonly storageState: string
}

const stateFile = (name: string) =>
  fileURLToPath(new URL(`../.auth/${name}.json`, import.meta.url))

// The setup project signs these up once per run, through the UI, so the specs
// sign in from saved state instead of signing up again: each sign-up counts
// against the per-address limits.
export const MEMBER: SharedAccount = {
  name: "Mira Member",
  email: "member@example.com",
  password: "member passphrase",
  storageState: stateFile("member"),
}

/** On the Test stage's ADMIN_EMAILS (playwright.config.ts). */
export const ADMIN: SharedAccount = {
  name: "Adi Admin",
  email: "admin@example.com",
  password: "admin passphrase",
  storageState: stateFile("admin"),
}

export const SHARED_ACCOUNTS = [MEMBER, ADMIN] as const
