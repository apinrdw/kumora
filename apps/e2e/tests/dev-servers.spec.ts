import { expect, test } from "@playwright/test"

// Apps left on the default probe 9229 and bind it later. Two started together
// crash with EADDRINUSE only when the race goes badly, and otherwise one falls
// back to 9230. The app holding 9229 shows the race in every run.
for (const origin of ["http://localhost:3000", "http://localhost:3001"]) {
  test(`${origin} does not take the default inspector port`, async ({
    request,
  }) => {
    const debugPage = await (await request.get(`${origin}/__debug`)).text()
    const port = /ws=localhost%3A(\d+)/.exec(debugPage)?.[1]
    expect(port).toMatch(/^\d+$/)
    expect(port).not.toBe("9229")
  })
}
