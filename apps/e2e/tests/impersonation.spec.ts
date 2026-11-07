import { expect, test } from "../support/test"

import { ADMIN, DASHBOARD, MEMBER } from "../support/accounts"

const USERS = `${DASHBOARD}/admin/users`

test.use({ storageState: ADMIN.storageState })

test("an admin views the dashboard as a member, read-only, and stops", async ({
  page,
}) => {
  const banner = page.getByRole("status").filter({ hasText: "Viewing as" })

  await test.step("impersonate the member from /admin/users", async () => {
    await page.goto(USERS)
    const row = (email: string) =>
      page
        .getByRole("table", { name: "Accounts" })
        .getByRole("row")
        .filter({ hasText: email })
    await expect(
      row(ADMIN.email).getByRole("button", { name: "Impersonate" })
    ).toHaveCount(0)
    await row(MEMBER.email).getByRole("button", { name: "Impersonate" }).click()
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
