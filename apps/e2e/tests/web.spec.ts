import { expect, test } from "@playwright/test"

const WEB = "http://localhost:3000"

test("GET / serves the landing page", async ({ page }) => {
  const response = await page.goto(`${WEB}/`)
  expect(response?.status()).toBe(200)
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible()
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
