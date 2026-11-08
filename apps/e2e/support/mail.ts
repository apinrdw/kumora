import { expect } from "@playwright/test"
import { readFile, readdir, stat } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

// Where `alchemy dev` writes the dashboard's outgoing mail as .eml files. The
// Mailer sends raw MIME, so each file carries its To: header.
const MAIL_DIR = fileURLToPath(
  new URL("../../dashboard/.alchemy/local/email/", import.meta.url)
)

const VERIFY_LINK = /^(https?:\/\/\S+\/api\/auth\/verify-email\?\S+)$/m
const RESET_LINK = /^(https?:\/\/\S+\/api\/auth\/reset-password\/\S+)$/m
// The page is DELETE_ACCOUNT_PATH in apps/dashboard/src/server/auth/options.ts.
const DELETE_LINK = /^(https?:\/\/\S+\/delete-account\?token=\S+)$/m

async function newestLink(to: string, since: number, pattern: RegExp) {
  const names = await readdir(MAIL_DIR).catch(() => [])
  const mails = await Promise.all(
    names
      .filter((name) => name.endsWith(".eml"))
      .map(async (name) => {
        const path = join(MAIL_DIR, name)
        return { path, written: (await stat(path)).mtimeMs }
      })
  )
  const recent = mails
    .filter((mail) => mail.written >= since)
    .sort((a, b) => b.written - a.written)
  for (const { path } of recent) {
    const raw = await readFile(path, "utf8")
    if (raw.match(/^To: (.+)$/m)?.[1]?.trim() !== to) continue
    const link = raw.match(pattern)?.[1]
    if (link) return link
  }
  return undefined
}

/**
 * The verification link in the newest mail to `to` written at or after
 * `since` (a `Date.now()` taken before the action that sends it). The send
 * runs after the response, so this waits for the file.
 */
export const verificationLink = (to: string, since: number) =>
  pollLink(to, since, VERIFY_LINK, "verification")

/** The password reset link, found the same way as `verificationLink`. */
export const resetLink = (to: string, since: number) =>
  pollLink(to, since, RESET_LINK, "reset")

/** The delete-account link, found the same way as `verificationLink`. */
export const deleteLink = (to: string, since: number) =>
  pollLink(to, since, DELETE_LINK, "delete-account")

async function pollLink(
  to: string,
  since: number,
  pattern: RegExp,
  kind: string
) {
  let link: string | undefined
  await expect
    .poll(async () => (link = await newestLink(to, since, pattern)), {
      message: `a ${kind} mail to ${to}`,
      timeout: 15_000,
    })
    .toBeDefined()
  return link as string
}
