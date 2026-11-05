import { expect, test } from "@playwright/test"

test("/ lands on Whale Radar with no console errors", async ({ page }) => {
  const errors: string[] = []
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text())
  })
  page.on("pageerror", (error) => errors.push(error.message))

  const response = await page.goto("http://localhost:3001/", {
    waitUntil: "networkidle",
  })

  expect(response?.status()).toBe(200)
  expect(new URL(page.url()).pathname).toBe("/radar")
  expect(response?.request().redirectedFrom()?.url()).toBe(
    "http://localhost:3001/"
  )
  await expect(page).toHaveTitle("KUMORA Terminal")
  await expect(page.getByText("KUMORA", { exact: false }).first()).toBeVisible()
  expect(errors).toEqual([])
})
