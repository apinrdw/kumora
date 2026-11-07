// Runs last, in its own project (playwright.config.ts): it spends a per-IP
// limit on purpose.
import { DASHBOARD, MEMBER } from "../support/accounts"
import { signIn, signInUrl } from "../support/flows"
import { expect, test } from "../support/test"

const WRONG = { ...MEMBER, password: "not the passphrase" }

test("an eleventh sign-in in a minute is told when to try again", async ({
  page,
}) => {
  await page.goto(signInUrl("/"))
  const alert = page.getByRole("alert")
  const attempt = async () => {
    const answered = page.waitForResponse(`${DASHBOARD}/api/auth/sign-in/email`)
    await signIn(page, WRONG)
    return (await answered).status()
  }

  for (let n = 1; n <= 10; n++) {
    expect(await attempt()).toBe(401)
    await expect(alert).toHaveText("Wrong email or password.")
  }
  expect(await attempt()).toBe(429)
  await expect(alert).toHaveText("Too many attempts. Try again in 1 minute.")
})
