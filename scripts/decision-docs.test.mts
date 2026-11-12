import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Path } from "effect"
import { TestConsole } from "effect/testing"

import { checkDecisionDocs } from "./decision-docs.mts"
import { CheckFailed } from "./lib/check.mts"
import { memoryFileSystem, recordingSpawner } from "./lib/testing.mts"

// Built, so this file's own lines don't point into an ADR directory or carry
// a tag.
const adrDocs = ["docs", "adr"].join("/")
const tag = ["Decision", ":"].join("")
const comment = (lines: number, marker = "//") => [
  `${marker} ${tag} one`,
  ...Array.from({ length: lines - 1 }, () => `${marker} more`),
]

// A repo whose index lists the files given, plus `unreadable` ones that are
// listed but not on disk.
const repo = (
  files: Record<string, string>,
  unreadable: ReadonlyArray<string> = []
) => {
  const index = recordingSpawner(() => ({
    stdout: [...Object.keys(files), ...unreadable]
      .map((file) => `${file}\n`)
      .join(""),
  }))
  const absolute = Object.fromEntries(
    Object.entries(files).map(([file, text]) => [`/repo/${file}`, text])
  )
  return {
    index,
    layer: Layer.mergeAll(index.layer, memoryFileSystem(absolute), Path.layer),
  }
}

describe("checkDecisionDocs", () => {
  it.effect("passes on a repo with no ADRs", () => {
    const { index, layer } = repo({
      "README.md": "Decisions are `Decision:` comments.",
      "assets/logo.png": `\0PNG ${adrDocs}/ inside binary`,
    })
    return Effect.gen(function* () {
      yield* checkDecisionDocs("/repo")
      assert.include(index.calls[0]?.args ?? [], ":(exclude)repos")
      assert.deepStrictEqual(yield* TestConsole.logLines, [
        "Checked 2 files: no ADRs, every Decision in shape.",
      ])
    }).pipe(Effect.provide(layer))
  })

  it.effect(
    "fails with CheckFailed naming ADR files and links into them",
    () => {
      const { layer } = repo({
        [`${adrDocs}/0001-use-effect.md`]: "# Use Effect",
        "AGENTS.md": `intro\nSee ${adrDocs}s/0001.md for why.`,
      })
      return Effect.gen(function* () {
        const error = yield* Effect.flip(checkDecisionDocs("/repo"))
        assert.instanceOf(error, CheckFailed)
        assert.deepStrictEqual(error.findings, [
          `${adrDocs}/0001-use-effect.md: lives in an ADR directory`,
          "AGENTS.md:2: points into an ADR directory",
        ])
      }).pipe(Effect.provide(layer))
    }
  )

  it.effect("skips a listed file it cannot read", () => {
    const { layer } = repo({ "README.md": "" }, ["docs/adr-notes.md"])
    return Effect.gen(function* () {
      yield* checkDecisionDocs("/repo")
      assert.deepStrictEqual(yield* TestConsole.logLines, [
        "Checked 2 files: no ADRs, every Decision in shape.",
      ])
    }).pipe(Effect.provide(layer))
  })

  it.effect(
    "passes a five-line decision, closed by an empty comment line or */",
    () => {
      const { layer } = repo({
        "a.ts": [...comment(5), "//", "// Unrelated.", "const a = 1"].join(
          "\n"
        ),
        "b.tsx": ["/**", ...comment(5, " *"), " */"].join("\n"),
        "c.yml": [...comment(5, "#"), "key: value"].join("\n"),
        "d.ts": `// Prose about the \`${tag}\` tag.`,
        "e.md": `Notes. ${tag} prose, not a comment.`,
      })
      return Effect.gen(function* () {
        yield* checkDecisionDocs("/repo")
      }).pipe(Effect.provide(layer))
    }
  )

  it.effect(
    "counts every line of a block comment whose lines carry no * prefix",
    () => {
      const plain = Array.from({ length: 6 }, () => "  more")
      const { layer } = repo({
        "a.tsx": [`{/* ${tag} one`, ...plain, "*/}"].join("\n"),
        "b.ts": [`/** ${tag} one`, ...plain.slice(1), "  more */"].join("\n"),
      })
      return Effect.gen(function* () {
        const error = yield* Effect.flip(checkDecisionDocs("/repo"))
        assert.instanceOf(error, CheckFailed)
        assert.deepStrictEqual(error.findings, [
          "a.tsx:1: Decision runs 7 lines; keep 5 and link the PR for the rest",
          "b.ts:1: Decision runs 7 lines; keep 5 and link the PR for the rest",
        ])
      }).pipe(Effect.provide(layer))
    }
  )

  it.effect(
    "passes a tag in a string or a YAML value, outside a comment",
    () => {
      const { layer } = repo({
        "a.ts": `const label = '${tag} keep'`,
        "b.yml": `description: "${tag} keep"`,
      })
      return Effect.gen(function* () {
        yield* checkDecisionDocs("/repo")
      }).pipe(Effect.provide(layer))
    }
  )

  it.effect(
    "reads no Decision in SQL or HTML, and fails one after code",
    () => {
      const { layer } = repo({
        "a.sql": [`-- ${tag} one`, "--", `select 1 -- What. ${tag} why`].join(
          "\n"
        ),
        "b.html": [
          `<!-- ${tag} one`,
          ...Array.from({ length: 5 }, () => "more"),
          "-->",
        ].join("\n"),
        "c.ts": `const a = 1 // ${tag} why`,
      })
      return Effect.gen(function* () {
        const error = yield* Effect.flip(checkDecisionDocs("/repo"))
        assert.instanceOf(error, CheckFailed)
        assert.deepStrictEqual(error.findings, [
          `c.ts:1: ${tag} sits partway along a line; open a comment line with it`,
        ])
      }).pipe(Effect.provide(layer))
    }
  )

  it.effect("keeps a decision open past a line comment ending in */", () => {
    const { layer } = repo({
      "a.ts": [
        `// ${tag} one`,
        "// see apps/*/",
        ...Array.from({ length: 4 }, () => "// more"),
      ].join("\n"),
    })
    return Effect.gen(function* () {
      const error = yield* Effect.flip(checkDecisionDocs("/repo"))
      assert.instanceOf(error, CheckFailed)
      assert.deepStrictEqual(error.findings, [
        "a.ts:1: Decision runs 6 lines; keep 5 and link the PR for the rest",
      ])
    }).pipe(Effect.provide(layer))
  })

  it.effect("fails a decision over five lines, or one opening mid-line", () => {
    const { layer } = repo({
      "a.ts": [...comment(6), "const a = 1"].join("\n"),
      "b.tsx": ["/**", ...comment(5, " *"), " * more */"].join("\n"),
      "c.ts": `// What this does. ${tag} why.`,
    })
    return Effect.gen(function* () {
      const error = yield* Effect.flip(checkDecisionDocs("/repo"))
      assert.instanceOf(error, CheckFailed)
      assert.deepStrictEqual(error.findings, [
        "a.ts:1: Decision runs 6 lines; keep 5 and link the PR for the rest",
        "b.tsx:2: Decision runs 6 lines; keep 5 and link the PR for the rest",
        `c.ts:1: ${tag} sits partway along a line; open a comment line with it`,
      ])
    }).pipe(Effect.provide(layer))
  })

  // Each case below was misread by the line classifier these tests replaced.
  const findings = (files: Record<string, string>) =>
    Effect.flip(checkDecisionDocs("/repo")).pipe(
      Effect.map((error) => {
        assert.instanceOf(error, CheckFailed)
        return error.findings
      }),
      Effect.provide(repo(files).layer)
    )
  const passes = (files: Record<string, string>) =>
    checkDecisionDocs("/repo").pipe(Effect.provide(repo(files).layer))
  const partway = (at: string) =>
    `${at}: ${tag} sits partway along a line; open a comment line with it`

  it.effect("passes comment markers inside strings and template literals", () =>
    passes({
      "a.ts": [
        `const example = "text // ${tag} example"`,
        `const hash = "x # ${tag} y"`,
        `const dash = 'x -- ${tag} y'`,
        "const t = `",
        `see a // ${tag} x`,
        "`",
      ].join("\n"),
      "b.yml": `k: "a # ${tag} b"`,
      "c.json": `{ "a": "x // ${tag} y" }`,
    })
  )

  it.effect("fails a block comment opened after code", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* findings({
          "a.ts": `const n = 1; /* Context. ${tag} keep it */`,
          "b.ts": ["foo() /* start", ` * ${tag} keep it */`].join("\n"),
        }),
        [partway("a.ts:1"), partway("b.ts:2")]
      )
    })
  )

  it.effect("fails a tag after code with no space, or in inline JSX", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* findings({
          "a.ts": `a();// ${tag} x`,
          "b.tsx": `const d = <div>{/* ${tag} x */}</div>`,
        }),
        [partway("a.ts:1"), partway("b.tsx:1")]
      )
    })
  )

  it.effect("ends a decision at a private field after it", () =>
    passes({
      "a.ts": ["class A {", ...comment(5, "  //"), "  #field = 1", "}"].join(
        "\n"
      ),
    })
  )

  it.effect("reads no block comment from a /* that is not one", () =>
    passes({
      ".gitignore": ["/*", "!keep", `# ${tag} x`].join("\n"),
      "a.ts": ["const glob = `", "/* all", "`", `// ${tag} one`].join("\n"),
    })
  )

  it.effect("reads JSONC comments", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* findings({
          "a.jsonc": ["{", ...comment(6, "  //"), '  "a": 1', "}"].join("\n"),
        }),
        [
          "a.jsonc:2: Decision runs 6 lines; keep 5 and link the PR for the rest",
        ]
      )
    })
  )

  it.effect("names a file it cannot parse and reads no Decision in it", () =>
    Effect.gen(function* () {
      yield* passes({ "a.ts": ["const = ;", ...comment(6)].join("\n") })
      assert.deepStrictEqual(yield* TestConsole.errorLines, [
        "a.ts: does not parse, so no Decision in it was read",
      ])
    })
  )
})
