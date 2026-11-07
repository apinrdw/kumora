import { createServerFn } from "@tanstack/react-start"
import { getRequest } from "@tanstack/react-start/server"
import { runServerEffect } from "@workspace/server"

import { probeReport } from "@/server/probe"

export const getProbeReport = createServerFn({ method: "GET" }).handler(() =>
  runServerEffect(probeReport(getRequest()))
)
