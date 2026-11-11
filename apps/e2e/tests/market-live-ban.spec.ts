import { ADMIN, DASHBOARD } from "../support/accounts"
import { signInUrl, signUp } from "../support/flows"
import { verificationLink } from "../support/mail"
import { expect, newClientContext, test } from "../support/test"

const PAGE = "/market-live"

test.use({ storageState: ADMIN.storageState })

test("a ban closes the member's open Market Live page, which lands on sign-in", async ({
  browser,
  page: admin,
}) => {
  // Its own account: banning a shared one would end the sessions the other
  // specs share.
  const member = {
    name: "Lia Live",
    email: `live-banned-${Date.now()}@example.com`,
    password: "banned passphrase",
  }
  const memberContext = await newClientContext(browser)
  const memberPage = await memberContext.newPage()
  const since = Date.now()
  await memberPage.goto(`${DASHBOARD}/sign-up`)
  await signUp(memberPage, member)
  await memberPage.goto(await verificationLink(member.email, since))
  await expect(memberPage).toHaveURL(`${DASHBOARD}/`)

  // Live once the object answered the page's Select with a snapshot. Any of
  // the page's sockets: a dev build's first mount may drop its own.
  const snapshot = new Promise<void>((resolve) =>
    memberPage.on("websocket", (ws) => {
      if (ws.url().endsWith("/market-live/live"))
        ws.on("framereceived", () => resolve())
    })
  )
  await memberPage.goto(`${DASHBOARD}${PAGE}`)
  await snapshot

  await admin.goto(
    `${DASHBOARD}/admin/users?q=${encodeURIComponent(member.email)}`
  )
  const row = admin
    .getByRole("table", { name: "Accounts" })
    .getByRole("row")
    .filter({ hasText: member.email })
  await row.getByRole("button", { name: `Actions for ${member.email}` }).click()
  await admin.getByRole("menuitem", { name: "Ban…" }).click()
  await admin
    .getByRole("alertdialog", { name: `Ban ${member.email}?` })
    .getByRole("button", { name: "Ban account" })
    .click()
  await expect(admin.getByRole("status")).toHaveText(`Banned ${member.email}.`)

  await expect(memberPage).toHaveURL(signInUrl(PAGE))

  await memberContext.close()
})
