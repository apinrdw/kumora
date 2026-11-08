import { createFileRoute } from "@tanstack/react-router"
import type { ErrorComponentProps } from "@tanstack/react-router"
import { runServerEffect } from "@workspace/server"
import { LoaderError, loadServerFn, runLoader } from "@workspace/server/loader"
import { Effect, Option, Schema } from "effect"

import { getProbeReport } from "@/server/get-probe-report"
import { probe } from "@/server/probe"

// Pure, so ProbeError runs it with runSync in render.
const loaderErrorOf = Effect.fnUntraced(function* (error: unknown) {
  return yield* Effect.option(Schema.decodeUnknownEffect(LoaderError)(error))
})

export const Route = createFileRoute("/probe")({
  loader: () => runLoader(loadServerFn(() => getProbeReport())),
  component: ProbePage,
  errorComponent: ProbeError,
  notFoundComponent: ProbeNotFound,
  server: {
    handlers: {
      // curl, the runbook's stage check and the e2e smoke read JSON. A browser
      // asks for HTML, so it falls through to the page.
      GET: ({ request, next }) =>
        request.headers.get("accept")?.includes("text/html")
          ? next()
          : runServerEffect(probe(request)),
    },
  },
})

function ProbePage() {
  const report = Route.useLoaderData()
  return (
    <main className="container mx-auto p-4 pt-16">
      <h1>Deploy probe</h1>
      <dl>
        <dt>Origin</dt>
        <dd>{report.origin}</dd>
        <dt>Secret SHA-256 prefix</dt>
        <dd>{report.secretSha256Prefix ?? "absent"}</dd>
      </dl>
    </main>
  )
}

function ProbeNotFound() {
  return (
    <main className="container mx-auto p-4 pt-16">
      <h1>Probe not found</h1>
    </main>
  )
}

function ProbeError({ error }: ErrorComponentProps) {
  const loaderError = Effect.runSync(loaderErrorOf(error))
  return (
    <main className="container mx-auto p-4 pt-16">
      {Option.isSome(loaderError) ? (
        <>
          <h1>{loaderError.value._tag}</h1>
          <p>{loaderError.value.message}</p>
        </>
      ) : (
        <h1>Unexpected error</h1>
      )}
    </main>
  )
}
