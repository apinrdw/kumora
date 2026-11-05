type InstanceStatus = {
  status: "queued" | "running" | "errored" | "terminated" | "complete"
  error?: { name: string; message: string }
}

type Instance = { id: string; params: unknown }

type Entrypoint = {
  run: (event: never, step: never) => Promise<unknown>
}

/** Workflows' default for a step with no config of its own. */
const DEFAULT_RETRIES = 5

type RunOptions = {
  /** Runs a step's callback twice: what a retry after a lost acknowledgement does. */
  readonly repeatEachStep?: boolean
  /** Awaited before each attempt of a step. Throw from it to fail that attempt. */
  readonly beforeAttempt?: (name: string, attempt: number) => unknown
}

const stepRunner = (options: RunOptions) => {
  const attempt = async (
    name: string,
    callback: () => Promise<unknown>
  ): Promise<unknown> => {
    for (let n = 1; ; n++) {
      try {
        await options.beforeAttempt?.(name, n)
        // A step's output is serialized, so one that cannot be is a real failure.
        return structuredClone(await callback())
      } catch (error) {
        if (n > DEFAULT_RETRIES) throw error
      }
    }
  }

  return {
    do: async (name: string, callback: () => Promise<unknown>) => {
      if (options.repeatEachStep) await attempt(name, callback)
      return attempt(name, callback)
    },
  }
}

/**
 * Stands in for a `Workflow` binding. `create` only queues, as the real one
 * returns before the instance runs, so a test can look at the file in between.
 * `runAll` plays each queued instance against the entrypoint's real `run`, and
 * rejects with the first instance's error when its steps exhaust their retries.
 */
export const workflowBinding = (makeEntrypoint: () => Entrypoint) => {
  const queued: Array<Instance> = []
  const instances = new Map<string, InstanceStatus>()
  let refuseNext = false
  const handle = (id: string) => ({
    id,
    status: async () => instances.get(id),
  })
  return {
    binding: {
      create: async (instance: Instance) => {
        if (refuseNext) {
          refuseNext = false
          throw new Error("Workflows is unavailable")
        }
        // As in Workflows, `create` throws for an id in use. No message is documented.
        if (instances.has(instance.id))
          throw new Error(`instance ${instance.id} already exists`)
        instances.set(instance.id, { status: "queued" })
        queued.push(instance)
        return handle(instance.id)
      },
      // As in Workflows, `get` throws for an id with no instance.
      get: async (id: string) => {
        if (!instances.has(id)) throw new Error(`instance ${id} not found`)
        return handle(id)
      },
    } as unknown as Workflow,
    /** Every instance id created so far, in order. */
    ids: () => [...instances.keys()],
    /** Drops every instance, as if the request that inserted its file died before `create`. */
    forgetInstances: () => {
      instances.clear()
      queued.length = 0
    },
    /** Stops an instance, as an operator's `terminate` does, without running its catch. */
    terminate: (id: string) => {
      instances.set(id, { status: "terminated" })
      queued.splice(0, queued.length, ...queued.filter((i) => i.id !== id))
    },
    /** Makes the next `create` throw. */
    refuseNextCreate: () => {
      refuseNext = true
    },
    runAll: async (options: RunOptions = {}) => {
      for (const instance of queued.splice(0)) {
        instances.set(instance.id, { status: "running" })
        try {
          await makeEntrypoint().run(
            {
              payload: instance.params,
              timestamp: new Date(),
              instanceId: instance.id,
              workflowName: "fake",
            } as never,
            stepRunner(options) as never
          )
          if (instances.get(instance.id)?.status === "running")
            instances.set(instance.id, { status: "complete" })
        } catch (error) {
          const { name, message } = error as Error
          instances.set(instance.id, {
            status: "errored",
            error: { name, message },
          })
          throw error
        }
      }
    },
  }
}
