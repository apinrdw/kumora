import { asOwnClient, expect, test as setup } from "../support/test"

import { DASHBOARD, SHARED_ACCOUNTS } from "../support/accounts"
import { accountMenu, signUp } from "../support/flows"
import { verificationLink } from "../support/mail"

for (const account of SHARED_ACCOUNTS) {
  setup(`sign up and verify ${account.email}`, async ({ browser }) => {
    const context = await browser.newContext()
    await asOwnClient(context)
    const page = await context.newPage()
    const since = Date.now()
    await page.goto(`${DASHBOARD}/sign-up`)
    await signUp(page, account)

    await page.goto(await verificationLink(account.email, since))
    await expect(page).toHaveURL(`${DASHBOARD}/`)
    await expect(accountMenu(page, account.name)).toBeVisible()

    await context.storageState({ path: account.storageState })
    await context.close()
  })
}
