import { expect, newClientContext, test } from "../support/test"

import { ADMIN, DASHBOARD, MEMBER } from "../support/accounts"
import { signUp } from "../support/flows"

const USERS = `${DASHBOARD}/admin/users`

test.use({ storageState: ADMIN.storageState })

test("an admin views the dashboard as a member, read-only, and stops", async ({
  page,
}) => {
  const banner = page.getByRole("status").filter({ hasText: "Viewing as" })

  await test.step("impersonate the member from /admin/users", async () => {
    await page.goto(USERS)
    await page
      .getByRole("button", { name: `Actions for ${MEMBER.email}` })
      .click()
    await page.getByRole("menuitem", { name: "Impersonate" }).click()
    await expect(page).toHaveURL(`${DASHBOARD}/`)
    await expect(banner).toHaveText(`Viewing as ${MEMBER.email}·Stop`)
  })

  await test.step("the member's /account is read-only, under the banner", async () => {
    await page.goto(`${DASHBOARD}/account`)
    await expect(
      page.getByText("Read-only: this session can't change the account.")
    ).toBeVisible()
    await expect(page.getByLabel("Display name")).toBeDisabled()
    await expect(page.getByRole("button", { name: "Save name" })).toHaveCount(0)
    await expect(banner).toBeVisible()
  })

  await test.step("Stop returns to the admin's own session", async () => {
    await banner.getByRole("button", { name: "Stop" }).click()
    await expect(page).toHaveURL(USERS)
    await expect(page.getByRole("heading", { name: "Users" })).toBeVisible()
    await expect(banner).toHaveCount(0)
  })
})

test("an admin viewing as an unverified member keeps Stop on the verify screen", async ({
  browser,
  page,
}) => {
  const banner = page.getByRole("status").filter({ hasText: "Viewing as" })
  // Its own account, which never verifies.
  const member = {
    name: "Uni Unverified",
    email: `unverified-${Date.now()}@example.com`,
    password: "unverified passphrase",
  }
  const memberContext = await newClientContext(browser)
  const memberPage = await memberContext.newPage()
  await memberPage.goto(`${DASHBOARD}/sign-up`)
  await signUp(memberPage, member)
  await memberContext.close()

  await page.goto(`${USERS}?q=${encodeURIComponent(member.email)}`)
  await page
    .getByRole("button", { name: `Actions for ${member.email}` })
    .click()
  await page.getByRole("menuitem", { name: "Impersonate" }).click()
  await expect(page).toHaveURL(/\/verify\?/)
  await expect(
    page.getByRole("heading", { name: "Verify your email to continue" })
  ).toBeVisible()
  await expect(banner).toHaveText(`Viewing as ${member.email}·Stop`)

  await banner.getByRole("button", { name: "Stop" }).click()
  await expect(page).toHaveURL(USERS)
  await expect(banner).toHaveCount(0)
})
