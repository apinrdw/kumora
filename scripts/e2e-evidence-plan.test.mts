import { NodeServices } from "@effect/platform-node"
import { assert, layer } from "@effect/vitest"
import { Effect, FileSystem, Path, Schema } from "effect"

import {
  commentUrl,
  EvidenceRefused,
  evidencePlan,
  PlaywrightReport,
} from "./e2e-evidence-plan.mts"

const SHA = "b40ace6e4b02b88d864f939f7501f8de34b1df08"
const PR = { number: 217, headSha: SHA }

// A real JSON report of web, taken-email and market-live-select with
// E2E_VIDEO=on (11 passed), its checkout path replaced by /repo.
const report = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  return yield* Schema.decodeEffect(Schema.fromJsonString(PlaywrightReport))(
    yield* fs.readFileString(
      path.join(import.meta.dirname, "fixtures/e2e-evidence-report.json")
    )
  )
})

// What that run left in each results folder, as the shell lists it: the
// .webm files, repo-relative. A request-only test has an empty or no folder.
const results = "apps/e2e/test-results"
const listed: Record<string, ReadonlyArray<string>> = {
  "web-GET-serves-the-landing-page-chromium": ["video.webm"],
  "taken-email-the-owner-of-a-2e971-unt-through-the-mailed-link-chromium": [
    "page@a0193e67cba0c6be8365d1b731100033.webm",
    "page@3b02dfa9110f20441cf1bc739eea183e.webm",
  ],
  "market-live-select-the-cha-cbdcf--a-code-shares-above-rights-trading-day": [
    "video.webm",
  ],
  "market-live-select-the-and-Ctrl-K-palette-selects-a-code-trading-day": [
    "video.webm",
  ],
  "market-live-select-clicking-a-tape-row-selects-its-code-trading-day": [
    "video.webm",
  ],
  "market-live-select-the-sel-cd411-ad-and-a-bad-one-falls-back-trading-day": [
    "video.webm",
  ],
  "market-live-select-a-signed-out-code-list-GET-answers-401-trading-day": [],
}
const videos = new Map(
  Object.entries(listed).map(([folder, names]) => [
    `/repo/${results}/${folder}`,
    names.map((name) => `${results}/${folder}/${name}`),
  ])
)

const plan = (specs: ReadonlyArray<string>) =>
  Effect.flatMap(report, (playwright) =>
    evidencePlan({ specs, pr: PR, report: playwright, videos })
  )

layer(NodeServices.layer)("evidencePlan", (it) => {
  it.effect(
    "posts each test of a named spec under its title, with the summary, SHA and a success status",
    () =>
      Effect.gen(function* () {
        const post = yield* plan(["web.spec.ts"])
        const video = `${results}/web-GET-serves-the-landing-page-chromium/video.webm`
        assert.strictEqual(post.pr, 217)
        assert.deepStrictEqual(post.videos, [video])
        assert.strictEqual(
          post.body,
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
    "attaches every video in a test's folder, sorted by name, each in its own paragraph",
    () =>
      Effect.gen(function* () {
        const post = yield* plan(["taken-email.spec.ts"])
        const folder = `${results}/taken-email-the-owner-of-a-2e971-unt-through-the-mailed-link-chromium`
        const sorted = [
          `${folder}/page@3b02dfa9110f20441cf1bc739eea183e.webm`,
          `${folder}/page@a0193e67cba0c6be8365d1b731100033.webm`,
        ]
        assert.deepStrictEqual(post.videos, sorted)
        assert.include(
          post.body,
          `\n\n#### the owner of a squatted email takes the account through the mailed link\n\n![](${sorted[0]})\n\n![](${sorted[1]})\n\n`
        )
      })
  )

  it.effect(
    "covers one video per test of each named file and none from unnamed ones",
    () =>
      Effect.gen(function* () {
        const post = yield* plan([
          "apps/e2e/tests/market-live-select.spec.ts",
          "tests/taken-email.spec.ts",
        ])
        assert.lengthOf(post.videos, 6)
        assert.isTrue(
          post.videos.every(
            (video) =>
              video.includes("/market-live-select-") ||
              video.includes("/taken-email-")
          )
        )
        assert.notInclude(post.body, "web.spec.ts")
        assert.isBelow(
          post.body.indexOf("### market-live-select.spec.ts"),
          post.body.indexOf("### taken-email.spec.ts")
        )
        for (const title of [
          "the day's code list is served for the day, cacheable",
          "a signed-out code list GET answers 401",
        ])
          assert.include(post.body, `#### ${title}\n\nNo page, no video.`)
      })
  )

  it.effect("refuses a named spec that ran no test", () =>
    Effect.gen(function* () {
      const refused = yield* Effect.flip(
        plan(["web.spec.ts", "nonexistent.spec.ts"])
      )
      assert.instanceOf(refused, EvidenceRefused)
      assert.include(refused.message, "nonexistent.spec.ts")
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
