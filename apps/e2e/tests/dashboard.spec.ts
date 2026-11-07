import { expect, test } from "@playwright/test"

import { DASHBOARD, MEMBER } from "../support/accounts"
import { accountMenu } from "../support/flows"

test.use({ storageState: MEMBER.storageState })

test("/ renders the shell around the not-found page with no console errors", async ({
  page,
}) => {
  const errors: string[] = []
  page.on("console", (message) => {
    // With no pages yet, `/` itself answers 404, which the browser logs.
    if (message.location().url === `${DASHBOARD}/`) return
    if (message.type() === "error") errors.push(message.text())
  })
  page.on("pageerror", (error) => errors.push(error.message))

  const response = await page.goto(`${DASHBOARD}/`, {
    waitUntil: "networkidle",
  })

  expect(response?.status()).toBe(404)
  await expect(page).toHaveTitle("KUMORA Terminal")
  await expect(
    page.getByRole("heading", { name: "Halaman tidak ditemukan" })
  ).toBeVisible()
  await expect(page.getByText("WIB", { exact: true })).toBeVisible()
  await expect(accountMenu(page, MEMBER.name)).toBeVisible()
  expect(errors).toEqual([])
})
