import { createStart } from "@tanstack/react-start"
import { loaderErrorAdapter } from "@workspace/server/loader"

export const startInstance = createStart(() => ({
  serializationAdapters: [loaderErrorAdapter],
}))
