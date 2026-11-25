import { expect, newClientContext, test } from "../support/test"

import { testUrl } from "../support/accounts"

const WEB = testUrl("web")

test("GET / serves the landing page", async ({ page }) => {
  const response = await page.goto(`${WEB}/`)
  expect(response?.status()).toBe(200)
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "See who is buying. Line by line.",
    })
  ).toBeVisible()
  await expect(
    page.getByRole("table", { name: "BBRI · 10 Nov 2026" })
  ).toBeVisible()
})

test("GET /id serves the Indonesian landing page", async ({ page }) => {
  const response = await page.goto(`${WEB}/id`)
  expect(response?.status()).toBe(200)
  await expect(page.locator("html")).toHaveAttribute("lang", "id")
  await expect(
    page.getByRole("heading", { level: 1, name: /Lihat siapa yang membeli/ })
  ).toBeVisible()
})

test("joining the waitlist prints a queue number, once per email", async ({
  page,
  browser,
}) => {
  // Unique per run: the Test stage's waitlist keeps its rows between runs.
  const email = `waitlist-${Date.now()}@example.com`
  await page.goto(`${WEB}/`)
  const slip = page.locator("form").first()

  await slip.getByLabel("Email").fill("not-an-email")
  await slip.getByRole("button", { name: "Take a queue number" }).click()
  await expect(page.getByRole("alert")).toHaveText(
    "That email doesn't look right. Check it and try again."
  )

  await slip.getByLabel("Email").fill(email)
  await slip.getByRole("button", { name: "Take a queue number" }).click()
  const ticket = page.getByRole("status").first()
  await expect(ticket).toContainText("You're in the queue.")
  const number = (await ticket.textContent())?.match(/A-\d{4}/)?.[0] ?? ""
  expect(number).toMatch(/^A-\d{4}$/)

  // The same email from another browser gets the number it already holds.
  const other = await (await newClientContext(browser)).newPage()
  await other.goto(`${WEB}/`)
  const otherSlip = other.locator("form").first()
  await otherSlip.getByLabel("Email").fill(email.toUpperCase())
  await otherSlip.getByRole("button", { name: "Take a queue number" }).click()
  await expect(other.getByRole("status").first()).toContainText(number)
  await expect(other.getByRole("status").first()).toContainText(
    "already in the queue"
  )
})

test("GET /probe proves the secret reached the Worker", async ({ request }) => {
  const response = await request.get(`${WEB}/probe`)
  expect(response.status()).toBe(200)
  expect(response.headers()["cache-control"]).toBe("no-store")
  expect(await response.json()).toEqual({
    origin: WEB,
    secretPresent: true,
    secretSha256Prefix: expect.stringMatching(/^[0-9a-f]{12}$/),
  })
})
