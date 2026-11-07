import { expect, newClientContext, test } from "../support/test"

import { DASHBOARD } from "../support/accounts"
import { accountMenu, signIn, signInUrl, signUp } from "../support/flows"
import { resetLink } from "../support/mail"

const PAGE = "/market-live?day=2026-11-06"

test("the owner of a squatted email takes the account through the mailed link", async ({
  browser,
}) => {
  const email = `squatted-${Date.now()}@example.com`
  const squatter = {
    name: "Sam Squatter",
    email,
    password: "squatter passphrase",
  }
  const owner = { name: "Olga Owner", email, password: "owner passphrase" }

  const theirs = await newClientContext(browser)
  const squatting = await theirs.newPage()
  await squatting.goto(
    `${DASHBOARD}/sign-up?redirect=${encodeURIComponent(PAGE)}`
  )
  await signUp(squatting, squatter)

  const ours = await newClientContext(browser)
  const page = await ours.newPage()
  await page.goto(`${DASHBOARD}/sign-up?redirect=${encodeURIComponent(PAGE)}`)
  const since = Date.now()
  await signUp(page, owner)
  await expect(page.getByText(email)).toBeVisible()

  // The squatter's session ended at the owner's sign-up, before any link.
  const voided = await squatting.request.get(
    `${DASHBOARD}/api/auth/get-session?disableCookieCache=true`
  )
  expect(await voided.json()).toBeNull()

  await page.goto(await resetLink(email, since))
  await page.getByLabel("New password").fill(owner.password)
  await page.getByRole("button", { name: "Set password" }).click()
  await expect(
    page.getByRole("heading", { name: "Password set" })
  ).toBeVisible()
  await page
    .getByRole("link", { name: "Sign in with your new password" })
    .click()
  await signIn(page, owner)
  await expect(page).toHaveURL(`${DASHBOARD}${PAGE}`)
  // Verified, so the page shows. The account keeps the name the squatter
  // gave it; the owner changes it on /account.
  await expect(accountMenu(page, squatter.name)).toBeVisible()

  // The squatter's session is gone, and so is its password.
  const session = await squatting.request.get(
    `${DASHBOARD}/api/auth/get-session?disableCookieCache=true`
  )
  expect(await session.json()).toBeNull()
  await squatting.goto(signInUrl(PAGE))
  await signIn(squatting, squatter)
  await expect(squatting.getByRole("alert")).toHaveText(
    "Wrong email or password."
  )

  await theirs.close()
  await ours.close()
})
