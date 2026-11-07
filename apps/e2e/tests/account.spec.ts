import type { Page } from "@playwright/test"

import { expect, newClientContext, test } from "../support/test"

import { DASHBOARD } from "../support/accounts"
import { accountMenu, signIn, signInUrl, signUp } from "../support/flows"
import { verificationLink } from "../support/mail"

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

test("an account renames itself, changes its password and ends a session", async ({
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
    const profile = section(first, "Profile")
    await expect(profile.getByText(owner.email)).toBeVisible()
    await expect(profile.getByText("Member")).toBeVisible()
    await expect(profile.getByText("Password", { exact: true })).toBeVisible()
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
})
