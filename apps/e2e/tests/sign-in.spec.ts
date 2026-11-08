import { expect, test } from "../support/test"

import { DASHBOARD, MEMBER } from "../support/accounts"
import { accountMenu, signIn, signInUrl, signUp } from "../support/flows"
import { verificationLink } from "../support/mail"

const PAGE = "/market-live?day=2026-11-06"

test("an anonymous visit goes to sign-in, keeping the page asked for", async ({
  page,
}) => {
  await page.goto(`${DASHBOARD}${PAGE}`)
  await expect(page).toHaveURL(signInUrl(PAGE))
  await expect(
    page.getByRole("heading", { name: "Sign in to KUMORA" })
  ).toBeVisible()
  await expect(
    page.getByRole("link", { name: "Create an account" })
  ).toBeVisible()
  // Google is on only on Production and Staging.
  await expect(page.getByText("Google")).toHaveCount(0)
})

test("a new account signs up, verifies, and returns to the page asked for", async ({
  page,
}) => {
  const visitor = {
    name: "Vera Visitor",
    email: `visitor-${Date.now()}@example.com`,
    password: "visitor passphrase",
  }
  await page.goto(`${DASHBOARD}${PAGE}`)
  await page.getByRole("link", { name: "Create an account" }).click()
  const since = Date.now()
  await signUp(page, visitor)
  await expect(page.getByText(visitor.email)).toBeVisible()

  // Unverified, every page is the verify screen.
  await page.goto(`${DASHBOARD}${PAGE}`)
  await expect(
    page.getByRole("heading", { name: "Verify your email to continue" })
  ).toBeVisible()
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible()
  await expect(accountMenu(page, visitor.name)).toHaveCount(0)

  await page.goto(await verificationLink(visitor.email, since))
  await expect(page).toHaveURL(`${DASHBOARD}${PAGE}`)
  await expect(accountMenu(page, visitor.name)).toBeVisible()
})

test("an account signs out from the user menu and back in", async ({
  page,
}) => {
  await page.goto(signInUrl(PAGE))
  await signIn(page, MEMBER)
  await expect(page).toHaveURL(`${DASHBOARD}${PAGE}`)

  await accountMenu(page, MEMBER.name).click()
  await page.getByRole("menuitem", { name: "Sign out" }).click()
  await expect(page).toHaveURL(signInUrl(PAGE))

  // The session is gone, not just the page.
  await page.goto(`${DASHBOARD}${PAGE}`)
  await expect(page).toHaveURL(signInUrl(PAGE))

  await signIn(page, MEMBER)
  await expect(page).toHaveURL(`${DASHBOARD}${PAGE}`)
  await expect(accountMenu(page, MEMBER.name)).toBeVisible()
})

test("a wrong password is refused without saying which field was wrong", async ({
  page,
}) => {
  await page.goto(signInUrl(PAGE))
  await signIn(page, { ...MEMBER, password: "not the passphrase" })
  await expect(page.getByRole("alert")).toHaveText("Wrong email or password.")
  await expect(page).toHaveURL(signInUrl(PAGE))
})
