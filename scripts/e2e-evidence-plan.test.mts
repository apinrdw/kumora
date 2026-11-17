import { NodeServices } from "@effect/platform-node"
import { assert, layer } from "@effect/vitest"
import { Effect, Exit, FileSystem, Path, Schema } from "effect"

import {
  commentUrl,
  EvidenceRefused,
  evidencePlan,
  PlaywrightReport,
  postEvidence,
  preflight,
  type PostPlan,
} from "./e2e-evidence-plan.mts"

const SHA = "b40ace6e4b02b88d864f939f7501f8de34b1df08"
const PR = { number: 217, headSha: SHA }

const fixture = (name: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    return yield* Schema.decodeEffect(Schema.fromJsonString(PlaywrightReport))(
      yield* fs.readFileString(path.join(import.meta.dirname, "fixtures", name))
    )
  })

// A real JSON report of web, taken-email and market-live-select with
// E2E_VIDEO=on (11 passed), its checkout path replaced by /repo.
const green = fixture("e2e-evidence-report.json")
// A real JSON report of web and taken-email with E2E_VIDEO=on and
// --trace=retain-on-failure, with web's landing-page test made to fail
// (1 failed, 4 passed), its checkout path replaced by /repo.
const red = fixture("e2e-evidence-red-report.json")

// What a run left in each results folder, as the shell lists it: every file,
// repo-relative, with its size. A request-only test has an empty or no folder.
const results = "apps/e2e/test-results"
const MB = 1_000_000
const folders = (
  listed: Record<string, ReadonlyArray<readonly [string, number]>>
) =>
  new Map(
    Object.entries(listed).map(([folder, names]) => [
      `/repo/${results}/${folder}`,
      names.map(([name, bytes]) => ({
        path: `${results}/${folder}/${name}`,
        bytes,
      })),
    ])
  )
const greenFiles = folders({
  "web-GET-serves-the-landing-page-chromium": [["video.webm", 0.05 * MB]],
  "taken-email-the-owner-of-a-2e971-unt-through-the-mailed-link-chromium": [
    ["page@a0193e67cba0c6be8365d1b731100033.webm", 0.6 * MB],
    ["page@3b02dfa9110f20441cf1bc739eea183e.webm", 0.5 * MB],
  ],
  "market-live-select-the-cha-cbdcf--a-code-shares-above-rights-trading-day": [
    ["video.webm", 1 * MB],
  ],
  "market-live-select-the-and-Ctrl-K-palette-selects-a-code-trading-day": [
    ["video.webm", 1 * MB],
  ],
  "market-live-select-clicking-a-tape-row-selects-its-code-trading-day": [
    ["video.webm", 1 * MB],
  ],
  "market-live-select-the-sel-cd411-ad-and-a-bad-one-falls-back-trading-day": [
    ["video.webm", 1 * MB],
  ],
  "market-live-select-a-signed-out-code-list-GET-answers-401-trading-day": [],
})
const redFiles = folders({
  "web-GET-serves-the-landing-page-chromium": [
    ["error-context.md", 0.002 * MB],
    ["trace.zip", 0.2 * MB],
    ["video.webm", 0.05 * MB],
  ],
  "taken-email-the-owner-of-a-2e971-unt-through-the-mailed-link-chromium": [
    ["page@71ee8912abda0a5dc3c41df1b03cca02.webm", 0.6 * MB],
    ["page@cb588c83eafab5a2567cbbf0d5af7ea0.webm", 0.5 * MB],
  ],
})

// The green run's files with web's landing-page test given `count` videos.
const many = (count: number) => {
  const folder = `${results}/web-GET-serves-the-landing-page-chromium`
  return new Map([
    ...greenFiles,
    [
      `/repo/${folder}`,
      Array.from({ length: count }, (_, at) => ({
        path: `${folder}/page@${String(at).padStart(2, "0")}.webm`,
        bytes: MB,
      })),
    ],
  ])
}

// The plan's one comment, when its videos fit in one.
const onlyComment = (post: PostPlan) => {
  assert.lengthOf(post.comments, 1)
  return post.comments[0] ?? assert.fail("no comment")
}

// The checkout a run leaves alone: still clean, still on the PR's head.
const untouched = { dirty: [], head: SHA }
const OTHER_SHA = "0123456789abcdef0123456789abcdef01234567"

const plan = (
  specs: ReadonlyArray<string>,
  files: Parameters<typeof evidencePlan>[0]["files"] = greenFiles
) =>
  Effect.flatMap(green, (report) =>
    evidencePlan({
      specs,
      pr: PR,
      exitCode: 0,
      report,
      files,
      checkout: untouched,
      dryRun: false,
    })
  )

// A green run of web.spec.ts that ends on the given checkout.
const planAfter = (
  checkout: Parameters<typeof evidencePlan>[0]["checkout"],
  dryRun = false
) =>
  Effect.flatMap(green, (report) =>
    evidencePlan({
      specs: ["web.spec.ts"],
      pr: PR,
      exitCode: 0,
      report,
      files: greenFiles,
      checkout,
      dryRun,
    })
  )

const redPlan = (specs: ReadonlyArray<string>) =>
  Effect.flatMap(red, (report) =>
    evidencePlan({
      specs,
      pr: PR,
      exitCode: 1,
      report,
      files: redFiles,
      checkout: untouched,
      dryRun: false,
    })
  )

// Everything a real run needs, met.
const ready: Parameters<typeof preflight>[0] = {
  named: ["web.spec.ts"],
  changed: ["apps/web/src/routes/index.tsx", "apps/e2e/support/test.ts"],
  dirty: [],
  head: SHA,
  pr: PR,
  gh: "gh version 2.99.0 (2026-10-01)\nhttps://github.com/cli/cli/releases/tag/v2.99.0\n",
  dryRun: false,
}

const refusal = (inputs: Partial<typeof ready>) =>
  Effect.map(Effect.flip(preflight({ ...ready, ...inputs })), (refused) => {
    assert.instanceOf(refused, EvidenceRefused)
    return refused.message
  })

layer(NodeServices.layer)("preflight", (it) => {
  it.effect("selects only the named specs when no spec file changed", () =>
    Effect.gen(function* () {
      const { specs, unmet } = yield* preflight(ready)
      assert.deepStrictEqual(specs, ["web.spec.ts"])
      assert.deepStrictEqual(unmet, [])
    })
  )

  it.effect(
    "adds each spec file changed against the base after the named ones",
    () =>
      Effect.gen(function* () {
        const { specs } = yield* preflight({
          ...ready,
          changed: [
            "apps/e2e/tests/taken-email.spec.ts",
            "apps/e2e/tests/web.spec.ts",
            "apps/e2e/tests/accounts.setup.ts",
            "apps/e2e/support/test.ts",
            "apps/web/src/web.spec.ts",
          ],
        })
        assert.deepStrictEqual(specs, [
          "web.spec.ts",
          "apps/e2e/tests/taken-email.spec.ts",
        ])
      })
  )

  it.effect("selects a changed spec when none is named", () =>
    Effect.gen(function* () {
      const { specs } = yield* preflight({
        ...ready,
        named: [],
        changed: ["apps/e2e/tests/taken-email.spec.ts"],
      })
      assert.deepStrictEqual(specs, ["apps/e2e/tests/taken-email.spec.ts"])
    })
  )

  it.effect("refuses an empty selection, pointing at a spec or the label", () =>
    Effect.gen(function* () {
      const message = yield* refusal({ named: [] })
      assert.include(message, "Name a spec file")
      assert.include(message, "no-e2e-evidence")
    })
  )

  it.effect("refuses a dirty working tree, listing what is dirty", () =>
    Effect.gen(function* () {
      const message = yield* refusal({
        dirty: [" M apps/web/src/routes/index.tsx", "?? notes.txt"],
      })
      assert.include(message, "The working tree is dirty")
      assert.include(message, "apps/web/src/routes/index.tsx")
      assert.include(message, "notes.txt")
    })
  )

  it.effect("refuses a local HEAD that is not the PR's head, naming both", () =>
    Effect.gen(function* () {
      const head = "0123456789abcdef0123456789abcdef01234567"
      const message = yield* refusal({ head })
      assert.include(message, head)
      assert.include(message, SHA)
      assert.include(message, "PR #217")
    })
  )

  it.effect("refuses a branch with no PR", () =>
    Effect.gen(function* () {
      const message = yield* refusal({ pr: undefined })
      assert.include(message, "No PR")
      assert.include(message, "--pr")
    })
  )

  it.effect("refuses gh older than 2.99.0, naming the version found", () =>
    Effect.gen(function* () {
      const message = yield* refusal({
        gh: "gh version 2.96.0 (2026-07-02)\nhttps://github.com/cli/cli/releases/tag/v2.96.0\n",
      })
      assert.include(message, "2.96.0")
      assert.include(message, "2.99.0")
    })
  )

  it.effect("compares gh versions by number, not as text", () =>
    Effect.gen(function* () {
      for (const version of ["2.100.0", "3.0.0", "2.99.1"])
        yield* preflight({ ...ready, gh: `gh version ${version} (2027-01-01)` })
    })
  )

  it.effect("refuses a gh version it cannot read", () =>
    Effect.gen(function* () {
      assert.include(yield* refusal({ gh: "nope" }), "2.99.0")
    })
  )

  it.effect("names every unmet precondition in one refusal", () =>
    Effect.gen(function* () {
      const message = yield* refusal({
        dirty: ["?? notes.txt"],
        gh: "gh version 2.96.0 (2026-07-02)",
      })
      assert.include(message, "dirty")
      assert.include(message, "2.96.0")
    })
  )

  it.effect(
    "lets a dry run past the post's preconditions and reports them",
    () =>
      Effect.gen(function* () {
        const { specs, unmet } = yield* preflight({
          ...ready,
          dryRun: true,
          dirty: ["?? notes.txt"],
          head: "0123456789abcdef0123456789abcdef01234567",
          gh: "gh version 2.96.0 (2026-07-02)",
        })
        assert.deepStrictEqual(specs, ["web.spec.ts"])
        assert.lengthOf(unmet, 3)
      })
  )

  it.effect("refuses a dry run with no PR or an empty selection", () =>
    Effect.gen(function* () {
      assert.include(yield* refusal({ dryRun: true, pr: undefined }), "No PR")
      assert.include(
        yield* refusal({ dryRun: true, named: [] }),
        "no-e2e-evidence"
      )
    })
  )
})

layer(NodeServices.layer)("evidencePlan", (it) => {
  it.effect(
    "posts each test of a named spec under its title, with the summary, SHA and a success status",
    () =>
      Effect.gen(function* () {
        const post = yield* plan(["web.spec.ts"])
        const comment = onlyComment(post)
        const video = "./web-GET-serves-the-landing-page-chromium/video.webm"
        assert.strictEqual(post.pr, 217)
        assert.strictEqual(comment.bodyFile, `${results}/e2e-evidence-1.md`)
        assert.deepStrictEqual(comment.videos, [video])
        assert.strictEqual(
          comment.body,
          [
            "## e2e evidence",
            `The full suite passed on ${SHA}: 11 passed in 31 s.`,
            "### web.spec.ts",
            "#### GET / serves the landing page",
            `![](${video})`,
            "#### GET /probe proves the secret reached the Worker",
            "No page, no video.",
            "",
          ].join("\n\n")
        )
        assert.deepStrictEqual(post.status, {
          sha: SHA,
          state: "success",
          context: "e2e-evidence",
          description: "Full suite passed: 11 tests. Videos in the PR comment.",
        })
      })
  )

  it.effect(
    "writes each video's path relative to the body file's directory, so gh need not fall back to the working directory",
    () =>
      Effect.gen(function* () {
        const post = yield* plan(["web.spec.ts"])
        const comment = onlyComment(post)
        const video = "./web-GET-serves-the-landing-page-chromium/video.webm"
        assert.deepStrictEqual(comment.videos, [video])
        assert.include(comment.body, `![](${video})`)
        assert.notInclude(comment.body, results)
      })
  )

  it.effect(
    "attaches every video in a test's folder, sorted by name, each in its own paragraph",
    () =>
      Effect.gen(function* () {
        const post = yield* plan(["taken-email.spec.ts"])
        const comment = onlyComment(post)
        const folder =
          "./taken-email-the-owner-of-a-2e971-unt-through-the-mailed-link-chromium"
        const sorted = [
          `${folder}/page@3b02dfa9110f20441cf1bc739eea183e.webm`,
          `${folder}/page@a0193e67cba0c6be8365d1b731100033.webm`,
        ]
        assert.deepStrictEqual(comment.videos, sorted)
        assert.include(
          comment.body,
          `\n\n#### the owner of a squatted email takes the account through the mailed link\n\n![](${sorted[0]})\n\n![](${sorted[1]})\n\n`
        )
      })
  )

  it.effect(
    "covers one video per test of each selected file and none from others",
    () =>
      Effect.gen(function* () {
        const post = yield* plan([
          "apps/e2e/tests/market-live-select.spec.ts",
          "tests/taken-email.spec.ts",
        ])
        const comment = onlyComment(post)
        assert.lengthOf(comment.videos, 6)
        assert.isTrue(
          comment.videos.every(
            (video) =>
              video.includes("/market-live-select-") ||
              video.includes("/taken-email-")
          )
        )
        assert.notInclude(comment.body, "web.spec.ts")
        assert.isBelow(
          comment.body.indexOf("### market-live-select.spec.ts"),
          comment.body.indexOf("### taken-email.spec.ts")
        )
        for (const title of [
          "the day's code list is served for the day, cacheable",
          "a signed-out code list GET answers 401",
        ])
          assert.include(comment.body, `#### ${title}\n\nNo page, no video.`)
      })
  )

  it.effect("posts a spec named and also changed once", () =>
    Effect.gen(function* () {
      const post = yield* plan(["web.spec.ts", "apps/e2e/tests/web.spec.ts"])
      const comment = onlyComment(post)
      assert.lengthOf(comment.videos, 1)
    })
  )

  it.effect("refuses a selected spec that ran no test", () =>
    Effect.gen(function* () {
      const refused = yield* Effect.flip(
        plan(["web.spec.ts", "nonexistent.spec.ts"])
      )
      assert.instanceOf(refused, EvidenceRefused)
      assert.include(refused.message, "nonexistent.spec.ts")
    })
  )

  const failure = [
    "web.spec.ts › GET / serves the landing page",
    `  video: ${results}/web-GET-serves-the-landing-page-chromium/video.webm`,
    `  trace: ${results}/web-GET-serves-the-landing-page-chromium/trace.zip`,
  ].join("\n")

  it.effect(
    "blocks the post on a failed picked test, listing its video and trace",
    () =>
      Effect.gen(function* () {
        const refused = yield* Effect.flip(redPlan(["web.spec.ts"]))
        assert.instanceOf(refused, EvidenceRefused)
        assert.include(refused.message, "nothing was posted")
        assert.include(refused.message, failure)
        assert.notInclude(refused.message, "taken-email")
      })
  )

  it.effect("blocks the post on a failed test in an unpicked spec", () =>
    Effect.gen(function* () {
      const refused = yield* Effect.flip(redPlan(["taken-email.spec.ts"]))
      assert.instanceOf(refused, EvidenceRefused)
      assert.include(refused.message, failure)
    })
  )

  it.effect(
    "blocks the post when Playwright exits non-zero with no failed test",
    () =>
      Effect.gen(function* () {
        const report = yield* green
        const refused = yield* Effect.flip(
          evidencePlan({
            specs: ["web.spec.ts"],
            pr: PR,
            exitCode: 1,
            report: {
              ...report,
              errors: [{ message: "Error: did not expect test.only" }],
            },
            files: greenFiles,
            checkout: untouched,
            dryRun: false,
          })
        )
        assert.instanceOf(refused, EvidenceRefused)
        assert.include(refused.message, "exited 1")
        assert.include(refused.message, "did not expect test.only")
      })
  )

  it.effect(
    "refuses to post when a file changed while the suite ran, listing what is dirty",
    () =>
      Effect.gen(function* () {
        const refused = yield* Effect.flip(
          planAfter({
            dirty: [" M apps/web/src/routes/index.tsx", "?? notes.txt"],
            head: SHA,
          })
        )
        assert.instanceOf(refused, EvidenceRefused)
        assert.include(refused.message, "while the suite ran")
        assert.include(refused.message, "nothing was posted")
        assert.include(refused.message, "apps/web/src/routes/index.tsx")
        assert.include(refused.message, "notes.txt")
      })
  )

  it.effect(
    "refuses to post when HEAD left the PR's head while the suite ran, naming both",
    () =>
      Effect.gen(function* () {
        const refused = yield* Effect.flip(
          planAfter({ dirty: [], head: OTHER_SHA })
        )
        assert.instanceOf(refused, EvidenceRefused)
        assert.include(refused.message, "while the suite ran")
        assert.include(refused.message, OTHER_SHA)
        assert.include(refused.message, SHA)
        assert.include(refused.message, "PR #217")
      })
  )

  it.effect(
    "lets a dry run past a checkout that changed during the run and reports it",
    () =>
      Effect.gen(function* () {
        const post = yield* planAfter(
          { dirty: ["?? notes.txt"], head: OTHER_SHA },
          true
        )
        assert.lengthOf(post.unmet, 2)
        assert.include(post.unmet.join("\n"), "notes.txt")
        assert.include(post.unmet.join("\n"), OTHER_SHA)
        assert.strictEqual(post.status.sha, SHA)
      })
  )

  it.effect(
    "reports nothing unmet after a run that left the checkout alone",
    () =>
      Effect.gen(function* () {
        assert.deepStrictEqual((yield* planAfter(untouched)).unmet, [])
        assert.deepStrictEqual((yield* planAfter(untouched, true)).unmet, [])
      })
  )

  it.effect("refuses a video over 100 MB, naming its test", () =>
    Effect.gen(function* () {
      const folder = `${results}/web-GET-serves-the-landing-page-chromium`
      const refused = yield* Effect.flip(
        plan(
          ["web.spec.ts"],
          new Map([
            ...greenFiles,
            [
              `/repo/${folder}`,
              [{ path: `${folder}/video.webm`, bytes: 100 * MB + 1 }],
            ],
          ])
        )
      )
      assert.instanceOf(refused, EvidenceRefused)
      assert.include(refused.message, "GET / serves the landing page")
      assert.include(refused.message, "100 MB")
    })
  )

  it.effect("posts a video of exactly 100 MB", () =>
    Effect.gen(function* () {
      const folder = `${results}/web-GET-serves-the-landing-page-chromium`
      yield* plan(
        ["web.spec.ts"],
        new Map([
          ...greenFiles,
          [
            `/repo/${folder}`,
            [{ path: `${folder}/video.webm`, bytes: 100 * MB }],
          ],
        ])
      )
    })
  )

  it.effect(
    "splits 86 videos into comments of 50 and 36 in pick order, each naming its part",
    () =>
      Effect.gen(function* () {
        const post = yield* plan(["web.spec.ts"], many(86))
        const names = (from: number, to: number) =>
          Array.from(
            { length: to - from },
            (_, at) =>
              `./web-GET-serves-the-landing-page-chromium/page@${String(from + at).padStart(2, "0")}.webm`
          )
        assert.deepStrictEqual(
          post.comments.map((comment) => comment.videos),
          [names(0, 50), names(50, 86)]
        )
        assert.deepStrictEqual(
          post.comments.map((comment) => comment.bodyFile),
          [`${results}/e2e-evidence-1.md`, `${results}/e2e-evidence-2.md`]
        )
        const [first, second] = post.comments.map((comment) => comment.body)
        assert.isTrue(first?.startsWith("## e2e evidence, part 1 of 2\n\n"))
        assert.isTrue(second?.startsWith("## e2e evidence, part 2 of 2\n\n"))
        assert.notInclude(first, "No page, no video.")
        assert.include(
          second,
          `\n\n### web.spec.ts\n\n#### GET / serves the landing page\n\n![](${names(50, 51)[0]})\n\n`
        )
        assert.include(
          second,
          "\n\n#### GET /probe proves the secret reached the Worker\n\nNo page, no video.\n\n"
        )
        assert.strictEqual(
          post.status.description,
          "Full suite passed: 11 tests. Videos in 2 PR comments."
        )
      })
  )

  it.effect("posts 50 videos as one comment with no part in its title", () =>
    Effect.gen(function* () {
      const post = yield* plan(["web.spec.ts"], many(50))
      assert.lengthOf(post.comments, 1)
      assert.lengthOf(post.comments[0]?.videos ?? [], 50)
      assert.isTrue(post.comments[0]?.body.startsWith("## e2e evidence\n\n"))
    })
  )

  it.effect("ignores an oversize video of a test it does not post", () =>
    Effect.gen(function* () {
      const folder = `${results}/web-GET-serves-the-landing-page-chromium`
      yield* plan(
        ["taken-email.spec.ts"],
        new Map([
          ...greenFiles,
          [
            `/repo/${folder}`,
            [{ path: `${folder}/video.webm`, bytes: 500 * MB }],
          ],
        ])
      )
    })
  )
})

layer(NodeServices.layer)("postEvidence", (it) => {
  const url = (part: number) =>
    `https://github.com/apinrdw/kumora/pull/217#issuecomment-${part}`

  // Posts the 86-video plan, failing the comment whose part is `failAt`, and
  // returns what was called in order and how the post ended.
  const post = (failAt?: number) =>
    Effect.gen(function* () {
      const calls: Array<string> = []
      const exit = yield* Effect.exit(
        postEvidence(yield* plan(["web.spec.ts"], many(86)), {
          comment: (comment) => {
            const part = Number(/(\d+)\.md$/.exec(comment.bodyFile)?.[1])
            calls.push(`comment ${part}`)
            return part === failAt
              ? Effect.fail(new Error("gh: upload timed out"))
              : Effect.succeed(url(part))
          },
          status: (target) =>
            Effect.sync(() => {
              calls.push(`status ${target}`)
            }),
        })
      )
      return { calls, exit }
    })

  it.effect("sets the status only after the last part, linking the first", () =>
    Effect.gen(function* () {
      const { calls, exit } = yield* post()
      assert.isTrue(Exit.isSuccess(exit))
      assert.deepStrictEqual(calls, [
        "comment 1",
        "comment 2",
        `status ${url(1)}`,
      ])
    })
  )

  it.effect(
    "sets no status when a part fails, naming the parts posted and the cause",
    () =>
      Effect.gen(function* () {
        const { calls, exit } = yield* post(2)
        assert.deepStrictEqual(calls, ["comment 1", "comment 2"])
        const refused = yield* Effect.flip(exit)
        assert.instanceOf(refused, EvidenceRefused)
        assert.include(refused.message, "Part 2 of 2")
        assert.include(refused.message, "e2e-evidence status is unchanged")
        assert.include(refused.message, `part 1: ${url(1)}`)
        assert.include(refused.message, "gh: upload timed out")
      })
  )

  it.effect("says no part was posted when the first fails", () =>
    Effect.gen(function* () {
      const { calls, exit } = yield* post(1)
      assert.deepStrictEqual(calls, ["comment 1"])
      const refused = yield* Effect.flip(exit)
      assert.include(refused.message, "No part was posted")
    })
  )
})

layer(NodeServices.layer)("commentUrl", (it) => {
  it.effect("reads the comment URL gh pr comment prints", () =>
    Effect.gen(function* () {
      const url = "https://github.com/apinrdw/kumora/pull/217#issuecomment-123"
      assert.strictEqual(
        yield* commentUrl(`Uploading 2 files...\n${url}\n`),
        url
      )
    })
  )

  it.effect("fails when gh printed no comment URL", () =>
    Effect.gen(function* () {
      const failed = yield* Effect.flip(commentUrl("something else\n"))
      assert.include(failed.message, "something else")
    })
  )
})
