import { expect, type Page } from "@playwright/test"

import { DASHBOARD } from "./accounts"

interface Credentials {
  readonly name: string
  readonly email: string
  readonly password: string
}

/** Fills Create account on the page already open and waits for "Check your inbox". */
export async function signUp(page: Page, account: Credentials) {
  await page.getByLabel("Name").fill(account.name)
  await page.getByLabel("Email").fill(account.email)
  await page.getByLabel("Password").fill(account.password)
  await page.getByRole("button", { name: "Create account" }).click()
  await expect(
    page.getByRole("heading", { name: "Check your inbox" })
  ).toBeVisible()
}

/** Fills Sign in on the page already open. */
export async function signIn(page: Page, account: Credentials) {
  await page.getByLabel("Email").fill(account.email)
  await page.getByLabel("Password").fill(account.password)
  await page.getByRole("button", { name: "Sign in" }).click()
}

export const accountMenu = (page: Page, name: string) =>
  page.getByRole("button", { name: `Account menu for ${name}` })

export const signInUrl = (redirect: string) =>
  `${DASHBOARD}/sign-in?redirect=${encodeURIComponent(redirect)}`
