import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"

import { SignInForm } from "@/components/auth/sign-in-form"

import { renderAt } from "../../support/render-at"

const signIn = (props: { google: boolean; error?: string }) =>
  renderAt("/sign-in", () => <SignInForm redirect="/" {...props} />)

describe("SignInForm", () => {
  it.effect("offers Google above the email form, behind an 'or'", () =>
    Effect.gen(function* () {
      const html = yield* signIn({ google: true })
      const google = html.indexOf("Continue with Google")
      const or = html.indexOf(">or<")
      const email = html.indexOf('name="email"')
      expect(google).toBeGreaterThan(-1)
      expect(or).toBeGreaterThan(google)
      expect(email).toBeGreaterThan(or)
    })
  )

  it.effect("shows no Google button and no note where Google is off", () =>
    Effect.gen(function* () {
      const html = yield* signIn({ google: false })
      expect(html).not.toContain("Google")
      expect(html).not.toContain(">or<")
      expect(html).toContain('name="email"')
    })
  )

  it.effect("says to verify the password account when Google can't link", () =>
    Effect.gen(function* () {
      const html = yield* signIn({ google: true, error: "account_not_linked" })
      expect(html).toMatch(
        /role="alert"[^>]*>Sign in with your password and verify your email first\.</
      )
    })
  )

  it.effect("shows the suspended screen when Google comes back banned", () =>
    Effect.gen(function* () {
      const html = yield* signIn({ google: true, error: "BANNED_USER" })
      expect(html).toContain("This account is suspended")
      expect(html).not.toContain('name="password"')
      expect(html).not.toContain("Couldn&#x27;t sign in with Google")
    })
  )

  it.effect("says Google sign-in failed on any other Google error", () =>
    Effect.gen(function* () {
      const html = yield* signIn({ google: true, error: "invalid_code" })
      expect(html).toMatch(
        /role="alert"[^>]*>Couldn&#x27;t sign in with Google/
      )
    })
  )
})
