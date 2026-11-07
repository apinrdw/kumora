import { readdirSync, readFileSync } from "node:fs"
import type { DatabaseSync } from "node:sqlite"

// apps/dashboard/alchemy.run.ts hands this directory to the AuthDb D1, which
// applies the files in the same numeric-prefix order on each stage.
export const MIGRATIONS_DIR = new URL("../migrations/", import.meta.url)

const prefix = (file: string) => Number.parseInt(file, 10)

export function migrationFiles(): Array<string> {
  return readdirSync(MIGRATIONS_DIR)
    .filter((file) => /^\d+_.+\.sql$/.test(file))
    .sort((a, b) => prefix(a) - prefix(b))
}

export function replayMigrations(database: DatabaseSync): void {
  for (const file of migrationFiles())
    database.exec(readFileSync(new URL(file, MIGRATIONS_DIR), "utf8"))
}
