import { notFound } from "@tanstack/react-router"

/**
 * Calls a server function from a `beforeLoad` or `loader`, turning the
 * NotFound it fails with (thrown as a 404 Response, in SSR and in the browser
 * alike) into the router's not-found, so the route shows the normal
 * not-found page instead of an error.
 */
export async function orNotFound<A>(call: Promise<A>): Promise<A> {
  try {
    return await call
  } catch (error) {
    if (error instanceof Response && error.status === 404) throw notFound()
    throw error
  }
}
