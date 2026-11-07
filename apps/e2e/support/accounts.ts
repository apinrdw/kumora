import { TEST, stageUrl } from "@workspace/deploy"
import { fileURLToPath } from "node:url"

export const DASHBOARD = stageUrl("dashboard", TEST)

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
