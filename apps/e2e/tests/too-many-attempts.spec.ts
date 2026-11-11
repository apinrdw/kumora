// Spends the per-IP sign-in limit on purpose, from an address no other spec
// draws (support/test.ts newLimitSpendingContext), so it runs alongside them.
import { DASHBOARD, MEMBER } from "../support/accounts"
import { signIn, signInUrl } from "../support/flows"
import { expect, newLimitSpendingContext, test } from "../support/test"

const WRONG = { ...MEMBER, password: "not the passphrase" }

test("an eleventh sign-in in a minute is told when to try again", async ({
  browser,
}) => {
  const page = await (await newLimitSpendingContext(browser)).newPage()
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
