import { expect, newClientContext, test as setup } from "../support/test"

import { DASHBOARD, SHARED_ACCOUNTS } from "../support/accounts"
import { accountMenu, signUp } from "../support/flows"
import { verificationLink } from "../support/mail"
import { fromCloudflare } from "../support/turnstile"

for (const account of SHARED_ACCOUNTS) {
  setup(`sign up and verify ${account.email}`, async ({ browser }) => {
    // The one flow on Cloudflare's real widget (support/test.ts).
    const context = await newClientContext(browser, { turnstile: "cloudflare" })
    const page = await context.newPage()
    const widget = page.waitForResponse(fromCloudflare)
    const since = Date.now()
    await page.goto(`${DASHBOARD}/sign-up`)
    await signUp(page, account)
    await widget

    await page.goto(await verificationLink(account.email, since))
    await expect(page).toHaveURL(`${DASHBOARD}/`)
    await expect(accountMenu(page, account.name)).toBeVisible()

    await context.storageState({ path: account.storageState })
    await context.close()
  })
}
