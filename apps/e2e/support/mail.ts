import { expect } from "@playwright/test"
import { readFile, readdir, stat } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

// Where `alchemy dev` writes the dashboard's outgoing mail as .eml files. The
// Mailer sends raw MIME, so each file carries its To: header.
const MAIL_DIR = fileURLToPath(
  new URL("../../dashboard/.alchemy/local/email/", import.meta.url)
)

const LINK = /^(https?:\/\/\S+\/api\/auth\/verify-email\?\S+)$/m

async function newestLink(to: string, since: number) {
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
    const link = raw.match(LINK)?.[1]
    if (link) return link
  }
  return undefined
}

/**
 * The verification link in the newest mail to `to` written at or after
 * `since` (a `Date.now()` taken before the action that sends it). The send
 * runs after the response, so this waits for the file.
 */
export async function verificationLink(to: string, since: number) {
  let link: string | undefined
  await expect
    .poll(async () => (link = await newestLink(to, since)), {
      message: `a verification mail to ${to}`,
      timeout: 15_000,
    })
    .toBeDefined()
  return link as string
}
