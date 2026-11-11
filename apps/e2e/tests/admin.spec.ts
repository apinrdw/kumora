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

  test("the accounts table's sort lives in the URL, so it survives a reload", async ({
    page,
  }) => {
    await page.goto(USERS)
    const table = page.getByRole("table", { name: "Accounts" })
    const created = table.getByRole("columnheader", { name: "Created" })
    await expect(created).toHaveAttribute("aria-sort", "descending")
    // The email cells alone: suspended.spec.ts changes a row's status in
    // parallel, and the order is what this test is about.
    const emails = () =>
      table
        .getByRole("row")
        .filter({ hasText: "@" })
        .evaluateAll((rows) =>
          rows.map((row) =>
            Array.from((row as HTMLTableRowElement).cells)
              .map((cell) => cell.textContent ?? "")
              .find((text) => text.includes("@"))
          )
        )
    const newestFirst = await emails()

    // The page has just loaded: retry until hydration lets the header sort.
    await expect(async () => {
      await created.getByRole("button", { name: "Created" }).click()
      await expect(page).toHaveURL(/[?&]sort=createdAt&dir=asc/, {
        timeout: 1000,
      })
    }).toPass()
    await expect(created).toHaveAttribute("aria-sort", "ascending")
    // Oldest first, once the loader has fetched the re-sorted page.
    await expect.poll(emails).not.toEqual(newestFirst)
    // The shared accounts alone: the setup project signs them up before any
    // spec, so they stay the two oldest while specs running alongside sign up
    // accounts that land below them.
    const oldest = (await emails()).slice(0, 2)
    expect(oldest).toEqual(expect.arrayContaining([ADMIN.email, MEMBER.email]))

    await page.reload()
    await expect(page).toHaveURL(/[?&]sort=createdAt&dir=asc/)
    await expect(created).toHaveAttribute("aria-sort", "ascending")
    await expect.poll(async () => (await emails()).slice(0, 2)).toEqual(oldest)
  })
})
