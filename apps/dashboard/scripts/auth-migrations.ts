// Replays migrations/*.sql into a scratch SQLite database and asks Better
// Auth's generator what the auth config still needs.
//   node scripts/auth-migrations.ts <name>   writes the next migration
//   node scripts/auth-migrations.ts --check  fails if one is needed (CI)
import { writeFileSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { getMigrations } from "better-auth/db/migration"

import { authOptions } from "../src/server/auth/options.ts"
import {
  MIGRATIONS_DIR,
  migrationFiles,
  replayMigrations,
} from "./auth-schema.ts"

const [arg] = process.argv.slice(2)
const check = arg === "--check"
if (!check && !/^[a-z0-9_]+$/.test(arg ?? "")) {
  console.error(
    "Usage: node scripts/auth-migrations.ts <snake_case_name> | --check"
  )
  process.exit(2)
}

const database = new DatabaseSync(":memory:")
replayMigrations(database)

const { compileMigrations, unsafeChanges, schemaProblems } =
  await getMigrations(
    authOptions({
      database,
      baseURL: "http://localhost:3001",
      secret: "auth-migrations-placeholder-secret-0123456789",
      validateSchema: false,
      sendVerificationEmail: async () => {},
      sendResetPassword: async () => {},
      sendSetPassword: async () => {},
      verifyByPasswordReset: async () => {},
      turnstileSecretKey: "auth-migrations-placeholder",
      sendChangeEmailConfirmation: async () => {},
      sendNewEmailVerification: async () => {},
      sendDeleteAccountLink: async () => {},
      grantAdmin: async () => {},
      authorizeOwnAction: async () => {},
      authorizeEmailChange: async () => {},
      authorizeListAccounts: async () => {},
      authorizeAdminAction: async () => {},
    }),
    { throwOnUnsafe: false }
  )
const problems = [...unsafeChanges, ...schemaProblems]
const sql = await compileMigrations()
const pending = sql.trim() !== ";"

if (problems.length > 0) {
  console.error(`Auth schema problems:\n${problems.join("\n")}`)
  process.exit(1)
}

if (!pending) {
  console.log("Auth migrations match the Better Auth config.")
} else if (check) {
  console.error(
    `The Better Auth config needs a migration the checked-in ones lack:\n\n${sql}\n\nRun: pnpm --filter dashboard auth:migrations <name>`
  )
  process.exit(1)
} else {
  const next =
    Math.max(0, ...migrationFiles().map((f) => Number.parseInt(f, 10))) + 1
  const file = `${String(next).padStart(4, "0")}_${arg}.sql`
  writeFileSync(new URL(file, MIGRATIONS_DIR), `${sql}\n`)
  console.log(`Wrote migrations/${file}`)
}
