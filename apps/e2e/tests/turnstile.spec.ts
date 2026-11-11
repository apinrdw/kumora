import type { Response } from "@playwright/test"

import { DASHBOARD } from "../support/accounts"
import { expect, test } from "../support/test"
import { fromCloudflare } from "../support/turnstile"

test("the sign-up and reset forms get a Turnstile token without contacting Cloudflare", async ({
  page,
}) => {
  const responses: Response[] = []
  page.on("response", (response) => responses.push(response))

  await page.goto(`${DASHBOARD}/sign-up`)
  await expect(
    page.getByRole("button", { name: "Create account" })
  ).toBeEnabled()
  await page.goto(`${DASHBOARD}/forgot-password`)
  await expect(
    page.getByRole("button", { name: "Send reset link" })
  ).toBeEnabled()

  const reached = await Promise.all(responses.map(fromCloudflare))
  expect(responses.filter((_, i) => reached[i]).map((r) => r.url())).toEqual([])
})
