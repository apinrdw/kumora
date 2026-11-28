import { expect, test } from "../support/test"

import { DASHBOARD, MEMBER } from "../support/accounts"

test.use({ storageState: MEMBER.storageState })

test("Ctrl+K opens the command palette, and a page command opens that page", async ({
  page,
}) => {
  await page.goto(`${DASHBOARD}/account`)
  const palette = page.getByRole("dialog", { name: "Command palette" })

  // The page has just loaded: retry until hydration lets the shortcut open it.
  await expect(async () => {
    await page.keyboard.press("Control+k")
    await expect(palette).toBeVisible({ timeout: 1000 })
  }).toPass()
  const search = palette.getByRole("combobox", { name: "Search commands" })
  await expect(search).toBeFocused()
  await expect(palette.getByRole("option", { name: "Sign out" })).toBeVisible()
  await expect(palette.getByRole("option", { name: "Accounts" })).toHaveCount(0)

  await page.keyboard.type("bubbles")
  await page.keyboard.press("Enter")

  await expect(palette).toBeHidden()
  await expect(page).toHaveURL(`${DASHBOARD}/market-bubbles`)
})

test("the header's Commands button opens the palette, and Escape returns focus to it", async ({
  page,
}) => {
  await page.goto(`${DASHBOARD}/account`)
  const trigger = page.getByRole("button", { name: "Commands" })

  const palette = page.getByRole("dialog", { name: "Command palette" })
  // The page has just loaded: retry until hydration lets the button open it.
  await expect(async () => {
    await trigger.click({ timeout: 1000 })
    await expect(palette).toBeVisible({ timeout: 1000 })
  }).toPass()

  await page.keyboard.press("Escape")
  await expect(palette).toBeHidden()
  await expect(trigger).toBeFocused()
})
