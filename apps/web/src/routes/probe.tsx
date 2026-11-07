import { createFileRoute } from "@tanstack/react-router"
import type { ErrorComponentProps } from "@tanstack/react-router"
import { clientRuntime } from "@workspace/client"
import { runServerEffect } from "@workspace/server"
import { LoaderError, loadServerFn } from "@workspace/server/loader"
import { Schema } from "effect"

import { getProbeReport } from "@/server/get-probe-report"
import { probe } from "@/server/probe"

const isLoaderError = Schema.is(LoaderError)

export const Route = createFileRoute("/probe")({
  loader: () => clientRuntime.runPromise(loadServerFn(() => getProbeReport())),
  component: ProbePage,
  errorComponent: ProbeError,
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

function ProbeError({ error }: ErrorComponentProps) {
  return (
    <main className="container mx-auto p-4 pt-16">
      {isLoaderError(error) ? (
        <>
          <h1>{error._tag}</h1>
          <p>{error.message}</p>
        </>
      ) : (
        <h1>Unexpected error</h1>
      )}
    </main>
  )
}
