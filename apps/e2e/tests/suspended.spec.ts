import { expect, test } from "@playwright/test"

import { ADMIN, DASHBOARD } from "../support/accounts"
import { signIn, signInUrl, signUp } from "../support/flows"

const REASON = "Shared the account"

test("an admin bans a member, and the member sees the suspended screen", async ({
  browser,
}) => {
  // Its own account: banning a shared one would end the sessions the other
  // specs share.
  const member = {
    name: "Bima Banned",
    email: `banned-${Date.now()}@example.com`,
    password: "banned passphrase",
  }
  const memberContext = await browser.newContext()
  const memberPage = await memberContext.newPage()
  await memberPage.goto(`${DASHBOARD}/sign-up`)
  await signUp(memberPage, member)

  const adminContext = await browser.newContext({
    storageState: ADMIN.storageState,
  })
  const admin = await adminContext.newPage()
  await admin.goto(
    `${DASHBOARD}/admin/users?q=${encodeURIComponent(member.email)}`
  )
  const row = admin
    .getByRole("table", { name: "Accounts" })
    .getByRole("row")
    .filter({ hasText: member.email })
  await expect(row).toContainText("Member")
  await row.getByRole("button", { name: `Actions for ${member.email}` }).click()
  await admin.getByRole("menuitem", { name: "Ban…" }).click()
  const dialog = admin.getByRole("alertdialog", {
    name: `Ban ${member.email}?`,
  })
  await expect(dialog).toContainText("Every session of this account ends now")
  await dialog.getByLabel("Reason (optional)").fill(REASON)
  await dialog.getByRole("button", { name: "Ban account" }).click()
  await expect(admin.getByRole("status")).toHaveText(`Banned ${member.email}.`)
  await expect(row).toContainText("Suspended")
  await expect(row).toContainText(REASON)

  await memberPage.goto(signInUrl("/"))
  await signIn(memberPage, member)
  await expect(
    memberPage.getByRole("heading", { name: "This account is suspended" })
  ).toBeVisible()
  await expect(memberPage.getByText(REASON)).toHaveCount(0)
  await expect(memberPage.getByLabel("Password")).toHaveCount(0)

  await adminContext.close()
  await memberContext.close()
})
