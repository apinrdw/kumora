import { expect, test } from "../support/test"

import { ADMIN, DASHBOARD, MEMBER } from "../support/accounts"

const USERS = `${DASHBOARD}/admin/users`

test.describe("a member", () => {
  test.use({ storageState: MEMBER.storageState })

  test("gets the normal not-found page on /admin/users", async ({ page }) => {
    const response = await page.goto(USERS)
    expect(response?.status()).toBe(404)
    await expect(
      page.getByRole("heading", { name: "Halaman tidak ditemukan" })
    ).toBeVisible()
    await expect(page.getByRole("link", { name: "Accounts" })).toHaveCount(0)
  })
})

test.describe("an admin", () => {
  test.use({ storageState: ADMIN.storageState })

  test("finds accounts on /admin/users", async ({ page }) => {
    await page.goto(USERS)
    await expect(page.getByRole("heading", { name: "Accounts" })).toBeVisible()
    await expect(page.getByRole("link", { name: "Accounts" })).toBeVisible()
    const table = page.getByRole("table", { name: "Accounts" })
    await expect(
      table.getByRole("cell", { name: MEMBER.email, exact: true })
    ).toBeVisible()

    const search = page.getByRole("searchbox", { name: "Search" })
    await search.fill("mira")
    await expect(page).toHaveURL(/q=mira/)
    await expect(
      table.getByRole("cell", { name: ADMIN.email, exact: true })
    ).toHaveCount(0)
    const member = table.getByRole("row").filter({ hasText: MEMBER.email })
    await expect(member).toContainText(MEMBER.name)
    await expect(member).toContainText("Member")
    await expect(member).toContainText("Active")
    await expect(member).toContainText("Password")

    // The Accounts link clears the search; the box follows the URL and doesn't
    // write the old search back.
    await page.getByRole("link", { name: "Accounts" }).click()
    await expect(search).toHaveValue("")
    await expect(page).toHaveURL(USERS)
    await expect(
      table.getByRole("cell", { name: ADMIN.email, exact: true })
    ).toBeVisible()
  })
})
