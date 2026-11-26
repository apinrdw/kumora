import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Path } from "effect"
import { TestConsole } from "effect/testing"

import { checkDecisionDocs } from "./decision-docs.mts"
import { CheckFailed } from "./lib/check.mts"
import { memoryFileSystem, recordingSpawner } from "./lib/testing.mts"

// Built, so this file's own lines don't point at an ADR or carry a tag.
const adrDocs = ["docs", "adr"].join("/")
const tag = ["Decision", ":"].join("")
const one = `${adrDocs}/0001-one.md`
// An ADR that a pointer to `one` reaches.
const anADR = { [one]: "# One\n\nWhy." }
// A decision of `lines` lines whose last names `target`.
const comment = (lines: number, marker = "//", target = one) => [
  `${marker} ${tag} one`,
  ...Array.from({ length: lines - 2 }, () => `${marker} more`),
  `${marker} (${target})`,
]
const runs = (at: string, lines: number) =>
  `${at}: Decision runs ${lines} lines; keep 2: a gist and the ADR path`

const adrFile = /(?:^|\/)docs\/adr\/\d{4}-[^/]*\.md$/

// Ends each ADR the way the checker asks, unless it already does: a `Sites:`
// list of the files that point at it, and a `Source:` line. The Sites and
// Source cases write their ADRs whole.
const wellFormed = (files: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(files).map(([file, text]) => {
      if (!adrFile.test(file) || /^(Sites:$|Source:)/m.test(text))
        return [file, text]
      const written = new RegExp(
        String.raw`\((?:\.\.?\/)*${file.replaceAll(".", "\\.")}\)`
      )
      const sites = Object.entries(files)
        .filter(([site, body]) => !site.endsWith(".md") && written.test(body))
        .map(([site]) => `- \`${site}\``)
      return [
        file,
        [
          text,
          ...(sites.length > 0 ? ["Sites:", ...sites, ""] : []),
          "Source: none",
        ].join("\n"),
      ]
    })
  )

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
    Object.entries(wellFormed(files)).map(([file, text]) => [
      `/repo/${file}`,
      text,
    ])
  )
  return Layer.mergeAll(index.layer, memoryFileSystem(absolute), Path.layer)
}

const findings = (files: Record<string, string>) =>
  Effect.flip(checkDecisionDocs("/repo")).pipe(
    Effect.map((error) => {
      assert.instanceOf(error, CheckFailed)
      return error.findings
    }),
    Effect.provide(repo(files))
  )
const passes = (files: Record<string, string>) =>
  checkDecisionDocs("/repo").pipe(Effect.provide(repo(files)))
const partway = (at: string) =>
  `${at}: ${tag} sits partway along a line; open a comment line with it`

describe("checkDecisionDocs", () => {
  it.effect("skips a listed file it cannot read, and a binary one", () =>
    Effect.gen(function* () {
      yield* checkDecisionDocs("/repo").pipe(
        Effect.provide(
          repo(
            {
              "README.md": "",
              "assets/logo.png": `\0PNG ${adrDocs}/0009-gone.md in binary`,
            },
            ["docs/notes.md"]
          )
        )
      )
      assert.deepStrictEqual(yield* TestConsole.logLines, [
        "Checked 3 files: every Decision points at an ADR, every ADR has one.",
      ])
    })
  )

  it.effect(
    "passes a two-line decision, closed by an empty comment line or */",
    () =>
      passes({
        ...anADR,
        "a.ts": [...comment(2), "//", "// Unrelated.", "const a = 1"].join(
          "\n"
        ),
        "b.tsx": ["/**", ...comment(2, " *"), " */"].join("\n"),
        "c.yml": [...comment(2, "#"), "key: value"].join("\n"),
        "d.ts": `// Prose about the \`${tag}\` tag.`,
        "e.md": `Notes. ${tag} prose, not a comment.`,
      })
  )

  it.effect(
    "counts every line of a block comment whose lines carry no * prefix",
    () =>
      Effect.gen(function* () {
        assert.deepStrictEqual(
          yield* findings({
            ...anADR,
            "a.tsx": [`{/* ${tag} one`, "  more", `  (${one})`, "*/}"].join(
              "\n"
            ),
            "b.ts": [`/** ${tag} one`, "  more", `  (${one}) */`].join("\n"),
          }),
          [runs("a.tsx:1", 3), runs("b.ts:1", 3)]
        )
      })
  )

  it.effect("passes a tag in a string or a YAML value, outside a comment", () =>
    passes({
      "a.ts": `const label = '${tag} keep'`,
      "b.yml": `description: "${tag} keep"`,
    })
  )

  it.effect("reads no Decision in SQL or HTML, and fails one after code", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* findings({
          "a.sql": [`-- ${tag} one`, "--", `select 1 -- What. ${tag} why`].join(
            "\n"
          ),
          "b.html": [`<!-- ${tag} one`, "more", "more", "-->"].join("\n"),
          "c.ts": `const a = 1 // ${tag} why`,
        }),
        [partway("c.ts:1")]
      )
    })
  )

  it.effect("passes pointers in shell, CSS and a YAML block scalar", () => {
    const adr = (n: number) => `${adrDocs}/000${n}-adr.md`
    return passes({
      ...Object.fromEntries([2, 3, 4, 5].map((n) => [adr(n), "# ADR"])),
      "b.sh": ["#!/bin/sh", ...comment(2, "#", adr(2)), "true"].join("\n"),
      "c.css": [`/* ${tag} one`, `   (${adr(3)}) */`, "a {}"].join("\n"),
      "d.yml": [
        "steps:",
        "  - run: |",
        ...comment(2, "      #", adr(4)),
        "      echo hi",
        "  - with:",
        "      script: |",
        ...comment(2, "        //", adr(5)),
        "        core.info(1)",
      ].join("\n"),
    })
  })

  it.effect("fails decisions in shell, CSS and a YAML block scalar", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* findings({
          ...anADR,
          "b.sh": ["#!/bin/sh", ...comment(3, "#")].join("\n"),
          "c.css": [`a {} /* ${tag} why */`, `/* ${tag} one */`].join("\n"),
          "d.yml": [
            "steps:",
            "  - run: |",
            ...comment(3, "      #"),
            "      echo hi",
          ].join("\n"),
        }),
        [
          runs("b.sh:2", 3),
          partway("c.css:1"),
          `c.css:2: Decision names no ADR; add its docs/adr/NNNN-slug.md path`,
          runs("d.yml:3", 3),
        ]
      )
    })
  )

  it.effect("keeps a decision open past a line comment ending in */", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* findings({
          ...anADR,
          "a.ts": [`// ${tag} one`, "// see apps/*/", `// (${one})`].join("\n"),
        }),
        [runs("a.ts:1", 3)]
      )
    })
  )

  it.effect("fails a decision over two lines, or one opening mid-line", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* findings({
          ...anADR,
          "a.ts": [...comment(3), "const a = 1"].join("\n"),
          "b.tsx": ["/**", ...comment(2, " *"), " * more */"].join("\n"),
          "c.ts": `// What this does. ${tag} why.`,
        }),
        [runs("a.ts:1", 3), runs("b.tsx:2", 3), partway("c.ts:1")]
      )
    })
  )

  it.effect("passes pointers into a workspace and the root ADR directory", () =>
    passes({
      ...anADR,
      [`packages/relay/${adrDocs}/0002-token-refusal.md`]: "# Refusal",
      "scripts/a.mts": comment(2).join("\n"),
      "packages/relay/src/b.ts": comment(
        2,
        "//",
        `packages/relay/${adrDocs}/0002-token-refusal.md`
      ).join("\n"),
    })
  )

  it.effect("fails a Decision that names no ADR, or one that is missing", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* findings({
          "a.ts": [`// ${tag} gist`, "// and no path"].join("\n"),
          "b.ts": comment(2, "//", `${adrDocs}/0002-gone.md`).join("\n"),
        }),
        [
          "a.ts:1: Decision names no ADR; add its docs/adr/NNNN-slug.md path",
          `b.ts:2: points at ${adrDocs}/0002-gone.md, which does not exist`,
        ]
      )
    })
  )

  it.effect("fails a pointer written from its file, not the repo root", () =>
    Effect.gen(function* () {
      const fromFile = (at: string, written: string) =>
        `${at}: Decision points at ${written}, a path from its file; write it from the repo root`
      assert.deepStrictEqual(
        yield* findings({
          ...anADR,
          "a.ts": comment(2, "//", `./${one}`).join("\n"),
          "src/b.ts": comment(2, "//", `../${one}`).join("\n"),
        }),
        [fromFile("a.ts:2", `./${one}`), fromFile("src/b.ts:2", `../${one}`)]
      )
    })
  )

  it.effect("passes ADR links that resolve, and reads no placeholder", () =>
    passes({
      ...anADR,
      [`packages/relay/${adrDocs}/0002-two.md`]: [
        "---",
        "Sites: none",
        "---",
        `# Two, after [one](../../../../${one})`,
      ].join("\n"),
      "AGENTS.md": [
        `See [one](${one}) and \`packages/relay/${adrDocs}/0002-two.md\`.`,
        `Write \`packages/relay/${adrDocs}/NNNN-token-refusal.md\`, or`,
        `\`<workspace>/${adrDocs}/0003-slug.md\`.`,
        `Upstream: https://github.com/a/b/blob/main/${adrDocs}/0009-x.md`,
      ].join("\n"),
      "a.ts": comment(2).join("\n"),
    })
  )

  it.effect("fails a Markdown link to an ADR that does not resolve", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* findings({
          "README.md": ["# Readme", `See [why](${adrDocs}/0003-gone.md).`].join(
            "\n"
          ),
        }),
        [`README.md:2: points at ${adrDocs}/0003-gone.md, which does not exist`]
      )
    })
  )

  const siteless = "---\nSites: none\n---\n# Siteless"

  it.effect("passes ADR numbers reused across directories", () =>
    passes({
      ...anADR,
      [`apps/web/${adrDocs}/0001-web.md`]: siteless,
      "a.ts": comment(2).join("\n"),
    })
  )

  it.effect("fails an ADR misnamed, or one reusing a number", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* findings({
          [`${adrDocs}/notes.md`]: siteless,
          [`${adrDocs}/0002-Bad_Name.md`]: siteless,
          [`${adrDocs}/0003-a.md`]: siteless,
          [`${adrDocs}/0003-b.md`]: siteless,
        }),
        [
          `${adrDocs}/notes.md: name it NNNN-<slug>.md`,
          `${adrDocs}/0002-Bad_Name.md: name it NNNN-<slug>.md`,
          `${adrDocs}: ADR number 0003 is used by 0003-a.md and 0003-b.md; renumber one`,
        ]
      )
    })
  )

  const two = `${adrDocs}/0002-two.md`
  const reversal = {
    [one]: "---\nStatus: superseded by ADR-0002\n---\n# One",
    [two]: `# Two\n\nReverses [one](0001-one.md), ${one}.`,
  }

  it.effect("passes a superseded ADR that only its successor links", () =>
    passes({ ...reversal, "a.ts": comment(2, "//", two).join("\n") })
  )

  it.effect("fails a pointer at a superseded ADR, naming its successor", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* findings({
          ...reversal,
          "a.ts": comment(2).join("\n"),
          "b.ts": comment(2, "//", two).join("\n"),
        }),
        [`a.ts:2: points at ${one}, superseded by ${two}; point there`]
      )
    })
  )

  it.effect("passes a Sites: none ADR that no Decision points at", () =>
    passes({ [one]: siteless })
  )

  it.effect("fails an ADR that only Markdown links, or nothing does", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* findings({
          ...anADR,
          [two]: "# Two",
          "AGENTS.md": `See ${one}.`,
        }),
        [
          `${one}: no Decision points here; add a pointer at its site, or mark it Sites: none`,
          `${two}: no Decision points here; add a pointer at its site, or mark it Sites: none`,
        ]
      )
    })
  )

  it.effect("passes an ADR whose Sites list is exactly its pointers", () =>
    passes({
      [one]:
        "# One\n\nWhy.\n\nSites:\n- `a.ts`\n- `b.ts`\n\nSource: apinrdw/kumora#1",
      "a.ts": comment(2).join("\n"),
      "b.ts": comment(2).join("\n"),
    })
  )

  it.effect(
    "passes a Sites list set off by a blank line, as vp fmt writes it",
    () =>
      passes({
        [one]:
          "# One\n\nWhy.\n\nSites:\n\n- `a.ts`\n- `b.ts`\n\nSource: apinrdw/kumora#1",
        "a.ts": comment(2).join("\n"),
        "b.ts": comment(2).join("\n"),
      })
  )

  it.effect(
    "fails an ADR with no Source line, or a Sites list off its pointers",
    () =>
      Effect.gen(function* () {
        assert.deepStrictEqual(
          yield* findings({
            [one]: "# One\n\nSites:\n- `a.ts`\n- `gone.ts`",
            [two]: "# Two\n\nSource: none",
            "a.ts": comment(2).join("\n"),
            "b.ts": comment(2).join("\n"),
            "c.ts": comment(2, "//", two).join("\n"),
          }),
          [
            `${one}: add a Source: line naming its issue or PR, or Source: none`,
            `${one}: b.ts points here; add it to Sites`,
            `${one}: Sites lists gone.ts, which holds no Decision pointing here; drop it`,
            `${two}: add a Sites: list naming c.ts`,
          ]
        )
      })
  )

  // Each case below was misread by the line classifier these tests replaced.
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
          // A `{` before a comment is JSX only in a JSX file.
          "c.ts": `{ // ${tag} x\n}`,
        }),
        [partway("a.ts:1"), partway("b.tsx:1"), partway("c.ts:1")]
      )
    })
  )

  it.effect("ends a decision at a private field after it", () =>
    passes({
      ...anADR,
      "a.ts": ["class A {", ...comment(2, "  //"), "  #field = 1", "}"].join(
        "\n"
      ),
    })
  )

  it.effect("reads no block comment from a /* that is not one", () =>
    passes({
      ...anADR,
      ".gitignore": ["/*", "!keep", `# ${tag} x`].join("\n"),
      "a.ts": ["const glob = `", "/* all", "`", ...comment(2)].join("\n"),
    })
  )

  it.effect("reads JSONC comments", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* findings({
          ...anADR,
          "a.jsonc": ["{", ...comment(3, "  //"), '  "a": 1', "}"].join("\n"),
          // No final newline after a closing line comment.
          "b.jsonc": ['{ "a": 1 }', ...comment(3)].join("\n"),
        }),
        [runs("a.jsonc:2", 3), runs("b.jsonc:2", 3)]
      )
    })
  )

  it.effect("reads YAML comments", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* findings({
          ...anADR,
          "a.yml": [...comment(3, "#"), "key: value"].join("\n"),
        }),
        [runs("a.yml:1", 3)]
      )
    })
  )

  it.effect("names a file it cannot parse and reads no Decision in it", () =>
    Effect.gen(function* () {
      yield* passes({
        "a.ts": ["const = ;", `// ${tag} one`, "// more", "// more"].join("\n"),
      })
      assert.deepStrictEqual(yield* TestConsole.errorLines, [
        "a.ts: does not parse, so no Decision in it was read",
      ])
    })
  )
})
