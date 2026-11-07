import type { Page } from "@playwright/test"

import { expect, newClientContext, test } from "../support/test"

import { ADMIN, DASHBOARD } from "../support/accounts"
import { accountMenu, signIn, signInUrl, signUp } from "../support/flows"
import { deleteLink, verificationLink } from "../support/mail"

const ACCOUNT = `${DASHBOARD}/account`

// Its own account, because it changes the password and ends sessions, which
// would sign the shared accounts out of every other spec.
const owner = {
  name: "Owen Owner",
  email: `owner-${Date.now()}@example.com`,
  password: "owner passphrase",
}

const section = (page: Page, name: string) => page.getByRole("region", { name })

const otherSessions = (page: Page) =>
  section(page, "Sessions")
    .getByRole("listitem")
    .filter({ hasNotText: "This device" })

test("an account renames itself, changes its password, ends a session, moves to a new email and deletes itself", async ({
  browser,
}) => {
  const first = await (await newClientContext(browser)).newPage()
  const second = await (await newClientContext(browser)).newPage()

  await test.step("sign up, verify, and open /account from the user menu", async () => {
    const since = Date.now()
    await first.goto(`${DASHBOARD}/sign-up`)
    await signUp(first, owner)
    await first.goto(await verificationLink(owner.email, since))
    await expect(first).toHaveURL(`${DASHBOARD}/`)
    // The page has just loaded: retry until hydration lets the menu open.
    const item = first.getByRole("menuitem", { name: "Account" })
    await expect(async () => {
      await accountMenu(first, owner.name).click()
      await expect(item).toBeVisible({ timeout: 1000 })
    }).toPass()
    await item.click()
    await expect(first).toHaveURL(ACCOUNT)
    const details = section(first, "Details")
    await expect(details.getByText(owner.email)).toBeVisible()
    await expect(details.getByText("Member")).toBeVisible()
    await expect(details.getByText("Password", { exact: true })).toBeVisible()
  })

  await test.step("rename", async () => {
    await first.getByLabel("Display name").fill("Owen Renamed")
    await first.getByRole("button", { name: "Save name" }).click()
    await expect(first.getByRole("status")).toHaveText("Name saved.")
    await expect(accountMenu(first, "Owen Renamed")).toBeVisible()
  })

  await test.step("change the password, which signs the other browser out", async () => {
    await second.goto(signInUrl("/account"))
    await signIn(second, owner)
    await expect(second).toHaveURL(ACCOUNT)
    await expect(
      section(second, "Sessions").getByText("This device")
    ).toHaveCount(1)

    await first.reload()
    await expect(otherSessions(first)).not.toHaveCount(0)
    await expect(first.getByLabel("Sign out other sessions")).toBeChecked()
    await first.getByLabel("Current password").fill(owner.password)
    await first.getByLabel("New password").fill("a new passphrase")
    await first.getByRole("button", { name: "Change password" }).click()
    await expect(first.getByRole("status")).toHaveText("Password changed.")
    await expect(otherSessions(first)).toHaveCount(0)

    await second.reload()
    await expect(second).toHaveURL(signInUrl("/account"))
  })

  await test.step("end the other browser's session", async () => {
    await signIn(second, { ...owner, password: "a new passphrase" })
    await expect(second).toHaveURL(ACCOUNT)

    await first.reload()
    await expect(otherSessions(first)).toHaveCount(1)
    await otherSessions(first).getByRole("button", { name: "End" }).click()
    await expect(first.getByRole("status")).toContainText("Ended the session")
    await expect(otherSessions(first)).toHaveCount(0)

    await second.reload()
    await expect(second).toHaveURL(signInUrl("/account"))
  })

  const newEmail = `moved-${Date.now()}@example.com`

  await test.step("change the email: the old address confirms, the new one verifies", async () => {
    const since = Date.now()
    const email = section(first, "Email")
    await email.getByLabel("New email").fill(newEmail)
    await email.getByRole("button", { name: "Change email" }).click()
    await expect(email.getByRole("status")).toHaveText(
      `Check ${owner.email} for a link to confirm the change.`
    )

    await first.goto(await verificationLink(owner.email, since))
    await expect(first).toHaveURL(ACCOUNT)
    await expect(section(first, "Details").getByText(owner.email)).toBeVisible()

    await first.goto(await verificationLink(newEmail, since))
    await expect(first).toHaveURL(ACCOUNT)
    await expect(section(first, "Details").getByText(newEmail)).toBeVisible()
  })

  await test.step("delete the account by the emailed link, which ends every session", async () => {
    await signIn(second, {
      ...owner,
      email: newEmail,
      password: "a new passphrase",
    })
    await expect(second).toHaveURL(ACCOUNT)

    const since = Date.now()
    const remove = section(first, "Delete account")
    await remove.getByRole("button", { name: "Email me a delete link" }).click()
    await expect(remove.getByRole("status")).toContainText(
      `Check ${newEmail} for a link`
    )

    await first.goto(await deleteLink(newEmail, since))
    await expect(
      first.getByRole("heading", { name: "Delete your account?" })
    ).toBeVisible()
    await first.getByRole("button", { name: "Delete account" }).click()
    await expect(
      first.getByRole("heading", { name: "Account deleted" })
    ).toBeVisible()

    await second.reload()
    await expect(second).toHaveURL(signInUrl("/account"))
  })
})

test.describe("a config admin", () => {
  test.use({ storageState: ADMIN.storageState })

  test("sees change email and delete account disabled, with the reason", async ({
    page,
  }) => {
    await page.goto(ACCOUNT)
    const email = section(page, "Email")
    await expect(email.getByLabel("New email")).toBeDisabled()
    await expect(
      email.getByRole("button", { name: "Change email" })
    ).toBeDisabled()
    await expect(
      email.getByText("Your email is on the admin list")
    ).toBeVisible()
    const remove = section(page, "Delete account")
    await expect(
      remove.getByRole("button", { name: "Email me a delete link" })
    ).toBeDisabled()
    await expect(
      remove.getByText("Your email is on the admin list")
    ).toBeVisible()
  })
})
