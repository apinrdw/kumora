// The one mapping of an access policy refusal to the closed HttpError set,
// for pages, server functions and the Better Auth hooks alike (spec
// apinrdw/kumora#80, "Access policy"). Better Auth answers an Unauthorized
// with 401 and drops where it would send the visitor.
import { Forbidden, NotFound, Unauthorized } from "@workspace/server"

import { withRedirect } from "../../lib/redirect.ts"
import type { Reason } from "./policy.ts"

// `href` is the page the visitor returns to once signed in or verified.
export const refusal = (reason: Reason, href: string) => {
  switch (reason) {
    // A suspended account holds no session, so it lands on sign-in, which
    // shows the suspended screen when Better Auth refuses it.
    case "sign-in":
    case "suspended":
      return new Unauthorized({ redirectTo: withRedirect("/sign-in", href) })
    case "verify":
      return new Unauthorized({ redirectTo: withRedirect("/verify", href) })
    case "not-found":
      return new NotFound({ message: "" })
    // A page shows "no access" as a page instead (gate.ts); anything without
    // a page to show it on is refused.
    case "no-access":
    case "forbidden":
      return new Forbidden({ message: "" })
  }
}
