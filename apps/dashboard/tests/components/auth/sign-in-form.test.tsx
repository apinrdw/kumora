import { describe, expect, test } from "vitest"

import { SignInForm } from "@/components/auth/sign-in-form"

import { renderAt } from "../../support/render-at"

const signIn = (props: { google: boolean; error?: string }) =>
  renderAt("/sign-in", () => <SignInForm redirect="/" {...props} />)

describe("SignInForm", () => {
  test("offers Google above the email form, behind an 'or'", async () => {
    const html = await signIn({ google: true })
    const google = html.indexOf("Continue with Google")
    const or = html.indexOf(">or<")
    const email = html.indexOf('name="email"')
    expect(google).toBeGreaterThan(-1)
    expect(or).toBeGreaterThan(google)
    expect(email).toBeGreaterThan(or)
  })

  test("shows no Google button and no note where Google is off", async () => {
    const html = await signIn({ google: false })
    expect(html).not.toContain("Google")
    expect(html).not.toContain(">or<")
    expect(html).toContain('name="email"')
  })

  test("says to verify the password account when Google can't link", async () => {
    const html = await signIn({ google: true, error: "account_not_linked" })
    expect(html).toMatch(
      /role="alert"[^>]*>Sign in with your password and verify your email first\.</
    )
  })

  test("says Google sign-in failed on any other Google error", async () => {
    const html = await signIn({ google: true, error: "invalid_code" })
    expect(html).toMatch(/role="alert"[^>]*>Couldn&#x27;t sign in with Google/)
  })
})
