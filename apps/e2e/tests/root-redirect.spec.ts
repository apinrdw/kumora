import { expect, test } from "../support/test"

import { DASHBOARD, MEMBER } from "../support/accounts"

test.use({ storageState: MEMBER.storageState })

// The dashboard's own host, with the dashboard under a path on it.
const HOST = new URL(DASHBOARD).origin

test("the host's root redirects into the dashboard", async ({ page }) => {
  const response = await page.request.get(`${HOST}/`, { maxRedirects: 0 })

  expect(response.status()).toBe(301)
  expect(new URL(response.headers()["location"] ?? "", HOST).href).toBe(
    `${DASHBOARD}/`
  )
})

test("an old path outside the dashboard lands on the same page under it, query kept", async ({
  page,
}) => {
  const response = await page.request.get(`${HOST}/stocks/BBCA?tab=brokers`, {
    maxRedirects: 0,
  })
  expect(response.status()).toBe(301)

  await page.goto(`${HOST}/stocks/BBCA?tab=brokers`)

  await expect(page).toHaveURL(`${DASHBOARD}/stocks/BBCA?tab=brokers`)
  await expect(page).toHaveTitle(/KUMORA Terminal$/)
})
