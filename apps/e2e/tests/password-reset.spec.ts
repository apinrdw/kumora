import { expect, newClientContext, test } from "../support/test"

import { DASHBOARD } from "../support/accounts"
import { accountMenu, signIn, signInUrl, signUp } from "../support/flows"
import { resetLink, verificationLink } from "../support/mail"

const PAGE = "/market-live?day=2026-11-06"

test("a reset link sets a new password, ends other sessions and returns to the page asked for", async ({
  browser,
}) => {
  // Its own account: resetting a shared one would end the sessions the other
  // specs share.
  const account = {
    name: "Rani Reset",
    email: `reset-${Date.now()}@example.com`,
    password: "first passphrase",
  }
  const elsewhere = await newClientContext(browser)
  const other = await elsewhere.newPage()
  await other.goto(`${DASHBOARD}/sign-up?redirect=${encodeURIComponent(PAGE)}`)
  const signedUp = Date.now()
  await signUp(other, account)
  await other.goto(await verificationLink(account.email, signedUp))
  await expect(accountMenu(other, account.name)).toBeVisible()

  const here = await newClientContext(browser)
  const page = await here.newPage()
  await page.goto(signInUrl(PAGE))
  await page.getByRole("link", { name: "Forgot password?" }).click()
  await page.getByLabel("Email").fill(account.email)
  const requested = Date.now()
  await page.getByRole("button", { name: "Send reset link" }).click()
  await expect(
    page.getByRole("heading", { name: "Reset link sent" })
  ).toBeVisible()
  await expect(
    page.getByText(`If ${account.email} has an account`)
  ).toBeVisible()

  await page.goto(await resetLink(account.email, requested))
  await page.getByLabel("New password").fill("second passphrase")
  await page.getByRole("button", { name: "Set password" }).click()
  await expect(
    page.getByRole("heading", { name: "Password set" })
  ).toBeVisible()
  await page
    .getByRole("link", { name: "Sign in with your new password" })
    .click()
  await signIn(page, { ...account, password: "second passphrase" })
  await expect(page).toHaveURL(`${DASHBOARD}${PAGE}`)
  await expect(accountMenu(page, account.name)).toBeVisible()

  // The other browser's session is gone from the server; pages trust its
  // 5-minute cookie cache until this fresh read clears it.
  const session = await other.request.get(
    `${DASHBOARD}/api/auth/get-session?disableCookieCache=true`
  )
  expect(await session.json()).toBeNull()
  await other.goto(`${DASHBOARD}${PAGE}`)
  await expect(other).toHaveURL(signInUrl(PAGE))

  await elsewhere.close()
  await here.close()
})

test("an unknown email gets the same 'Reset link sent'", async ({ page }) => {
  const email = `nobody-${Date.now()}@example.com`
  await page.goto(`${DASHBOARD}/forgot-password`)
  await page.getByLabel("Email").fill(email)
  await page.getByRole("button", { name: "Send reset link" }).click()
  await expect(
    page.getByRole("heading", { name: "Reset link sent" })
  ).toBeVisible()
  await expect(page.getByText(`If ${email} has an account`)).toBeVisible()
})
