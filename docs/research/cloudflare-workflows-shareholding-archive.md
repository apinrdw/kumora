# Cloudflare Workflows for a shareholding archive run

Research for [apinrdw/kumora#302](https://github.com/apinrdw/kumora/issues/302), a child of map [#295](https://github.com/apinrdw/kumora/issues/295). Read on 2026-11-14.

Settled before this ticket: the account is on Workers Paid, the archiver runs on the dashboard Worker with a Production-only cron ([#298](https://github.com/apinrdw/kumora/issues/298)), and R2 keys and change detection follow [#299](https://github.com/apinrdw/kumora/issues/299).

Sources:

- Cloudflare docs: [Limits](https://developers.cloudflare.com/workflows/reference/limits/) (updated Nov 10, 2026), [Pricing](https://developers.cloudflare.com/workflows/reference/pricing/) (Nov 4, 2026), [Workers API](https://developers.cloudflare.com/workflows/build/workers-api/), [Trigger Workflows](https://developers.cloudflare.com/workflows/build/trigger-workflows/), [Sleeping and retrying](https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/), [Rules of Workflows](https://developers.cloudflare.com/workflows/build/rules-of-workflows/).
- Vendored Alchemy, `repos/alchemy` (`@alchemy.run/cloudflare` 2.0.0-beta.85).
- Vendored Effect, `repos/effect` (4.1.2), `LLMS.md`.

## Limits and pricing on Workers Paid

From [Limits](https://developers.cloudflare.com/workflows/reference/limits/):

| Limit | Workers Paid |
| --- | --- |
| Steps per instance | 10,000 by default, configurable up to 25,000. `step.sleep` does not count. |
| Retries per step | 10,000 |
| CPU per step | 30 s by default, up to 5 min through `limits.cpu_ms` (the Worker's CPU limit). |
| Wall clock per step | Unlimited |
| Non-stream step result | 1 MiB (2^20 bytes) |
| Event payload (`params`) | 1 MiB |
| Persisted state per instance | 1 GB, including streamed step outputs |
| Subrequests | "10,000/request (default) / configurable up to 10 million" through `limits.subrequests` |
| Concurrent instances per account | 50,000. `waiting` and `paused` instances don't count. |
| Instance creation rate | 300/s per account, 100/s per Workflow |
| Instance ID length | 100 characters, pattern `^[a-zA-Z0-9_][a-zA-Z0-9-_]*$` |
| Completed instance state retention | 7 days by default, configurable up to 30 days |

Default step config when none is given ([Sleeping and retrying](https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/)): `retries: { limit: 5, delay: 10000, backoff: "exponential" }` and `timeout: "10 minutes"`, per attempt. [Rules of Workflows](https://developers.cloudflare.com/workflows/build/rules-of-workflows/) says to keep step timeouts at 30 minutes or less.

**Can an xlsx pass between steps?** A ~400 KB file fits under the 1 MiB non-stream limit, but a multi-MB file does not. A step can return a `ReadableStream<Uint8Array>` for larger binary output, but the stream counts toward the 1 GB instance storage, and the docs advise: "store very large or long-lived artifacts in external storage such as R2 and return a reference". So **each step downloads one file and writes it straight to R2**. Only small metadata (sha256, key, ETag) passes between steps.

**Pricing** ([Pricing](https://developers.cloudflare.com/workflows/reference/pricing/)). Paid includes 10 million requests/month, 30 million CPU ms/month, 1 GB-month of storage and 500,000 steps/month. Overage is $0.30 per million requests, $0.02 per million CPU ms, $0.20/GB-month and $0.80 per 100,000 steps. Retries and rollback handlers are not counted as steps. A creation counts as one request; steps are not requests. A backfill of ~150 steps and daily runs of a handful of steps use a tiny part of the included steps, so the cost is effectively $0.

**Unverified:** whether "10,000/request" for subrequests means per step invocation or per instance. The table row is labelled "per Workflow instance". Either way, a backfill needs about 145 GETs plus a few hundred R2 operations, well under 10,000.

## Starting an instance

**From `scheduled`.** The `scheduled` handler calls `env.SHAREHOLDING_ARCHIVE.create({ id, params })`. A Worker can create instances from `fetch`, `queue` or `scheduled` ([Trigger Workflows](https://developers.cloudflare.com/workflows/build/trigger-workflows/)). `create` returns once the instance is queued, so the cron invocation ends in milliseconds. The run's limits then come from the Workflow, not from the cron's 15-minute wall clock.

**A run-date ID gives "once per day".** `create` "throws an error if the provided ID is already used by an existing instance that has not yet passed its retention limit" ([Workers API, create](https://developers.cloudflare.com/workflows/build/workers-api/#create)). With `id: "cron-2026-11-14"`, a second start that day throws. The caller must catch that error and ignore it: the duplicate start is not a silent no-op. `createBatch` does not throw; it reports error code `10405` ("An instance with this ID already exists"). To run the same ID again, call `instance.restart()`. The guarantee only lasts while the first instance is retained (at most 30 days), which is enough for a daily ID.

**From an admin action.** A server function or route in the same Worker can call `create` too. Use a different ID scheme, for example `admin-<ISO timestamp>`, so an admin run never collides with the day's cron ID.

**Native Workflow `schedules` (alternative).** A Workflow binding can carry `schedules: ["<cron>"]`. Cloudflare then creates an instance at each match, with no Worker cron and no `scheduled` handler. The cron and fire time arrive on `event.schedule` ([Trigger Workflows](https://developers.cloudflare.com/workflows/build/trigger-workflows/)). On Paid, a cron-created instance runs for up to one hour per firing without taking a concurrency slot. The limit is 100 cron expressions per account. Alchemy supports this as `schedules` on the binding (`repos/alchemy/packages/cloudflare/src/Workflows/Workflow.ts`, `WorkflowRefProps.schedules`). Its local provider stores the schedules but never fires them (`ProviderLocal` in the same file, and no reader of `schedules` in `packages/cloudflare-runtime`). The cost: Cloudflare generates the instance IDs, so there is no date-keyed ID to dedupe on or to look up later. It also moves the Production-only gate from the Worker's `crons` to the binding's `schedules`.

## Run status for the admin view

`env.SHAREHOLDING_ARCHIVE.get(id)` returns an instance. `instance.status()` returns ([InstanceStatus](https://developers.cloudflare.com/workflows/build/workers-api/#instancestatus)):

```ts
{
  status: "queued" | "running" | "paused" | "errored" | "terminated"
        | "complete" | "waiting" | "waitingForPause" | "unknown";
  error?: { name: string; message: string };
  output?: unknown; // run()'s return value
  rollback: { outcome: "complete" | "failed"; error: ... } | null;
}
```

- **What it holds:** the instance status, the `run()` return value as `output`, and the error's name and message. Individual step outputs are not in `status()`. If the admin view needs counts (downloaded, skipped, unknown kinds), `run()` must return them as its output.
- **The binding has no list.** It has `create`, `createBatch`, `get` and `deleteBatch` ([Workers API](https://developers.cloudflare.com/workflows/build/workers-api/#workflow)). The dashboard can only read an instance whose ID it knows, so "last run" works only with deterministic IDs (look up `cron-<today>`, then the day before) or with the last ID stored somewhere. Listing instances needs the REST API and an API token (**unverified**: not read in detail).
- **How long it stays readable:** until the instance's retention ends. That is 7 days by default on Paid and up to 30 days, set per instance with `create({ retention: { successRetention, errorRetention } })` or per Workflow with `default_retention`. Alchemy's binding exposes neither `default_retention` nor `concurrency` (`WorkflowRefProps` has `workflowName`, `className`, `scriptName`, `limits.steps`, `schedules`, `jurisdiction`), so set retention per instance on `create`. Alchemy's `WorkflowInstanceCreateOptions` includes `retention`.
- **Consequence:** a run history older than 30 days, or one that survives deleting the Workflow, has to live in R2 or D1 anyway. The run's last step should write its result to R2 (for example `runs/<instance-id>.json`) as well as returning it.

## Step shape

Sizes: the backfill is ~145 reports (~56 MB, about 390 KB on average). A daily diff is a handful of new listings plus `HEAD`s on held URLs ([#299](https://github.com/apinrdw/kumora/issues/299)).

**One step per report download**, plus small planning and summary steps:

1. `plan` step: fetch the IDX listing and list the R2 bucket with custom metadata. Compute the set of (URL, ETag) pairs already held. Return the entries to download or check as plain JSON. About 145 entries × ~0.5 KB ≈ 75 KB, under 1 MiB. **Unverified:** the real listing record size.
2. `head <url>` steps, or one batched `heads` step, for held URLs whose ETag needs re-checking. How many `HEAD`s a run affords is #300's question. Batching them into one step keeps the step count low. A failed `HEAD` then retries the whole batch, which is harmless because `HEAD` has no side effects.
3. One `archive <kind>/<data-date>/<media-id>` step per entry to download. Each step does GET from `www.idx.id`, SHA-256, put the `.xlsx` if the hash is new, then put the `.json`, in the write order #299 fixed. It returns `{ key, sha256, etag, kind }`. Step names must be deterministic (Rules of Workflows), so build them from listing data, never from time or randomness.
4. `summary` step: write `runs/<instance-id>.json` to R2, and return the same object as `run()`'s output.

Why one step per report instead of batches: a failure retries one ~400 KB download, not a batch. Each step's CPU (hashing ~400 KB) is far below 30 s. The backfill is ~150 steps, 1.5% of the 10,000 default. Each step's writes are keyed by hash, so a retry after a partial write is harmless (#299). Batching would only matter past ~10,000 reports, or if step overhead turned out to be slow. Per-step latency is **unverified**.

Never return the xlsx bytes from a step.

## Alchemy support

**There is a Workflow binding, and it composes with `Cloudflare.Website.Vite` and a custom `main`.**

- `Cloudflare.Website.Vite` forwards its props to `Worker(...)` with the Vite `main` (`repos/alchemy/packages/cloudflare/src/Website/Vite.ts`, around line 295). `env` therefore takes any Worker binding.
- The Worker binding union includes `WorkflowLike<any>` (`repos/alchemy/packages/cloudflare/src/Workers/WorkerBinding.ts:250`). `Cloudflare.InferEnv` maps it to a typed `Workflow<Params>` (`Workers/InferEnv.ts:150`).
- For a host-local Workflow (no `scriptName`), the async binding path registers a `WorkflowResource` (`putWorkflow`) after the Worker. The default physical name derives from the stage-scoped Worker name and the class name, so each stage gets its own Workflow (`Workers/WorkerAsyncBindings.ts` around line 232, `Workflows/WorkflowName.ts`).
- This is the same "reference" form the stack already uses for `Cloudflare.DurableObject("TradingDay")`. In `apps/dashboard/alchemy.run.ts`:

  ```ts
  SHAREHOLDING_ARCHIVE: Cloudflare.Workflow<ArchiveParams>("ShareholdingArchive", {
    className: "ShareholdingArchive",
  }),
  ```

  `apps/dashboard/src/worker.ts` then exports a class `ShareholdingArchive extends WorkflowEntrypoint` from `cloudflare:workers`, next to the Durable Object exports, and adds `scheduled` to the default export.
- The Effect-native form, `Cloudflare.Workflow<Self>()(name, Effect.gen(...))` with `Cloudflare.Workflows.task`, requires an Effect-native `Worker` in its context (`WorkflowClass` in `Workflows/Workflow.ts`). The dashboard is an async Worker with a file `main`, so that form doesn't apply.
- CPU and subrequest limits are Worker-level `limits` (`WorkerLimits`, `Workers/Worker.ts:80` and `:826`, typed from the Cloudflare API's `limits` with `cpuMs` and `subrequests`). They apply to every handler on the dashboard Worker, including `fetch`. Alchemy's `WorkflowLimits` only has `steps`.

**Local dev (`bun alchemy dev`): supported, from reading the source; not run.**

- `LocalWorkerProvider` collects host-local `workflow` bindings into the local runtime's `workflows` (`repos/alchemy/packages/cloudflare/src/Workers/LocalWorkerProvider.ts:385-396`).
- The Workflows plugin persists instance state to disk under the local storage path (`repos/alchemy/packages/cloudflare-runtime/src/core/bindings/workflows/Workflows.ts`).
- The Vite dev server wraps each configured Workflow class in `createWorkflowEntrypointWrapper` (`cloudflare-runtime/src/vite/export-types.ts:32`, `vite/dev-server.ts:311`, `vite/module-runner/wrapper.worker.ts:330`). The class must be a named export of `main`, and the dev runtime restarts to pick up a new class (`vite/dev-plugin.ts:218-235`).
- The local Workflow provider is virtual and ignores `jurisdiction`; it stores `schedules` without firing them (`ProviderLocal` in `Workflows/Workflow.ts`).
- Worker `crons` do fire locally ([#298](https://github.com/apinrdw/kumora/issues/298); `cloudflare-runtime/src/core/RuntimeWorker.ts:39-45`). That is why the cron must stay Production-only. An admin "run now" in dev would create a local instance that calls IDX for real.

## Effect inside `WorkflowEntrypoint`

`repos/effect/LLMS.md` points non-Effect hosts to `ManagedRuntime` ("Integrating Effect into existing applications"), or, for small cases, `Effect.runPromise`. The dashboard already runs Effect at Promise boundaries this way (`apps/dashboard/src/server/auth/options.ts`, `mailer.ts`). Each `step.do` callback is such a boundary:

```ts
await step.do("archive …", config, () => Effect.runPromise(archiveOne(entry).pipe(Effect.provide(layer))))
```

Friction points:

1. **Step results must be structured-clone serializable and under 1 MiB** ([Workers API, step](https://developers.cloudflare.com/workflows/build/workers-api/#step)). Return plain encoded data (`Schema.encode`), never `Schema.Class` instances, `Option`, `Exit` or `DateTime`. Prototypes don't survive replay. Decode again with Schema after `step.do` returns.
2. **Errors flatten to name and message.** `status().error` is `{ name, message }`, so a tagged error's fields are lost. Put what the admin view needs into the message or the run output.
3. **Retry semantics.** Any rejection triggers the step's retry policy. To stop retrying a permanent failure (a 404, a schema mismatch), throw `NonRetryableError` from `cloudflare:workers` ([Workers API](https://developers.cloudflare.com/workflows/build/workers-api/#nonretryableerror)), for example by mapping such errors at the `runPromise` boundary. Don't add Effect `retry` inside a step on top of the step's own retries unless the two are meant to compound.
4. **Keep Effect out of control flow between steps.** Everything outside `step.do` re-runs on every replay ([Rules of Workflows](https://developers.cloudflare.com/workflows/build/rules-of-workflows/), "Do not rely on state outside of a step", "Avoid doing side effects outside of a `step.do`"). The `run()` body should be a plain `for` loop over the plan, with Effect only inside the callbacks.
5. **Step timeouts don't interrupt the fiber.** The docs mention no abort signal, so when a step times out, Effect finalizers may not run. **Unverified.** Set an Effect `timeout` shorter than the step timeout if cleanup matters.
6. Effect's own durable `effect/workflow` module (`repos/effect/packages/effect/src/workflow`) is a separate engine. Don't mix it with Cloudflare Workflows.

## Recommendation

**Use a Workflow, started by the dashboard Worker's Production-only cron (`scheduled` → `create({ id: "cron-<YYYY-MM-DD>" })`).** An admin action calls `create({ id: "admin-<timestamp>" })`.

```
run(event):
  plan       = step.do("plan")                       // IDX listing + R2 list → entries (JSON < 1 MiB)
  checked    = step.do("heads")                      // batched HEADs on held URLs (#300 sets the cap)
  results    = for entry in plan.toDownload ∪ checked.changed:
                 step.do(`archive ${kind}/${date}/${mediaId}`)  // GET → sha256 → put xlsx → put json
  summary    = step.do("summary")                    // write runs/<instance-id>.json; counts, unknown kinds
  return summary                                     // status().output for the admin view
```

`create` takes `retention: { successRetention: "30 days", errorRetention: "30 days" }`. Catch the error a duplicate `cron-<date>` start throws, and ignore it.

**Why a Workflow:**

- The backfill is ~145 sequential downloads from a host whose latency is **unverified**. A plain `scheduled` invocation has a 15-minute wall clock; a Workflow step has none, and the run as a whole has no time limit.
- A failed download retries alone, with backoff, instead of failing or ending the whole run.
- The admin view gets `status()` for free for 30 days, plus the date-keyed ID, without a separate status store for the in-progress state.
- Cost is effectively zero within the Paid inclusions, and Alchemy supports the binding, including local dev.

**Trade-offs and costs:**

- One more resource per stage: a Workflow, created on every Preview too, though only Production starts runs.
- A second `export` in `src/worker.ts`, a `scheduled` handler, and a Workflow class whose `run()` must follow replay rules.
- The admin view still needs R2 (or D1) for history beyond 30 days, and to find "last run" across days without listing.
- Effect runs only inside step callbacks, which costs some boundary code.

**When a plain `scheduled` handler would do instead.** #299 already makes every run idempotent and resumable: a crash means the next run downloads what's missing. If #300 chooses a capped batch per run (for example ≤ 30 downloads), a plain handler fits the 15-minute and 10,000-subrequest limits with margin and needs no new resource. The run result then goes to R2 only. Pick this if #300 caps the batch. Pick the Workflow if #300 wants the backfill in one run or an on-demand admin run that may be large.

**Native `schedules` on the Workflow** would remove the `scheduled` handler entirely, gated as `schedules: isProduction ? [cron] : []`. It loses the date-keyed instance ID that the admin view and the dedupe rely on. Prefer the Worker cron unless the run result is always read from R2.

## Unverified

- Real download latency and listing size from `www.idx.id`.
- Whether the subrequest limit counts per step invocation or per instance.
- REST API instance listing and per-step output detail.
- Effect finalizers on a Workflow step timeout.
- `bun alchemy dev` running a Workflow end to end: established by reading the source, not by running it.
- Nothing was deployed for this ticket.
