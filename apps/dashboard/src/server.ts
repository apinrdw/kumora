// The Worker entry. Owns /ws/*, /api/relay/* and /api/ownership/* before TanStack
// Start sees the request; everything else goes to Start's own handler.
import handler from "@tanstack/react-start/server-entry"

import {
  getStatus,
  IMPORTS_PATH,
  OWNERSHIP_STATUS_PATH,
  postImport,
  postRun,
  RUNS_PATH,
} from "@/ownership/routes"
import { checkClient, checkIngest, checkOperator } from "@/relay/auth"
import {
  INGEST_PATH,
  RELAY_NAME,
  STATUS_PATH,
  TRADES_PATH,
  OWN_SESSION_PATH,
} from "@/relay/routes"
import { parseSwitch } from "@/relay/upstream"

export { OwnershipLoad } from "@/ownership/load-workflow"
export { TradeRelay } from "@/relay/trade-relay"

const relay = (env: Env) => env.TRADE_RELAY.getByName(RELAY_NAME)

type Route = (
  request: Request,
  env: Env
) => Response | Promise<Response> | null | Promise<Response | null>

const setOwnSession = async (request: Request, env: Env) => {
  const enabled = parseSwitch(await request.text())
  if (enabled === null) return new Response("bad body", { status: 400 })
  return Response.json(await relay(env).setOwnSession(enabled))
}

/** One of the ownership routes: another method falls through, a wrong secret is refused. */
const ownershipRoute =
  (
    method: string,
    respond: (request: Request, env: Env) => Promise<Response>
  ): Route =>
  (request, env) => {
    if (request.method !== method) return null
    return (
      checkOperator(request, env.OWNERSHIP_INGEST_SECRET) ??
      respond(request, env)
    )
  }

/** A route that returns null is not this method's, and falls through to Start. */
const ROUTES: Partial<Record<string, Route>> = {
  [INGEST_PATH]: (request, env) =>
    checkIngest(request) ?? relay(env).fetch(request),
  [TRADES_PATH]: async (request, env) =>
    (await checkClient(request, env.RELAY_TICKET_SECRET, Date.now())) ??
    relay(env).fetch(request),
  [STATUS_PATH]: async (request, env) => {
    if (request.method !== "GET") return null
    return (
      checkOperator(request, env.RELAY_INGEST_SECRET) ??
      Response.json(await relay(env).status())
    )
  },
  [OWN_SESSION_PATH]: (request, env) => {
    if (request.method !== "POST") return null
    return (
      checkOperator(request, env.RELAY_INGEST_SECRET) ??
      setOwnSession(request, env)
    )
  },
  [IMPORTS_PATH]: ownershipRoute("POST", postImport),
  [RUNS_PATH]: ownershipRoute("POST", postRun),
  [OWNERSHIP_STATUS_PATH]: ownershipRoute("GET", (_, env) => getStatus(env)),
}

export default {
  async fetch(request: Request, env: Env) {
    const { pathname } = new URL(request.url)
    return (await ROUTES[pathname]?.(request, env)) ?? handler.fetch(request)
  },
}
