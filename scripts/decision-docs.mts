// Fails when a `Decision:` comment is not a pointer to an ADR, or an ADR is
// out of place. A pointer opens a comment line, runs two lines at most from
// its tag, and names, by its path from the repo root, an ADR that exists and is
// not superseded. Every ADR path in any file resolves, ADRs are named
// `NNNN-slug.md` with numbers unique per directory, and every ADR has a pointer
// or declares `Sites: none`. An ADR ends with a `Sites:` list, exactly the files
// whose pointer names it, and a `Source:` line. See docs/agents/domain.md.
// Comments come from parsers: oxc for JS, TS and JSON, `yaml` for YAML. Shell
// and CSS comments, and those inside a YAML block scalar, are found by their
// markers. A file of any other type is read for ADR links only, never for a
// Decision. That includes SQL: every .sql file is a D1 migration, and Alchemy
// refuses to deploy an applied migration edited even in a comment, so a
// Decision in one can never be rewritten as a pointer.
import { parseSync } from "oxc-parser"
import { Console, Effect, FileSystem, Option, Path } from "effect"
import { Parser } from "yaml"

import { CheckFailed } from "./lib/check.mts"
import { gitLines } from "./lib/command.mts"

const maxDecisionLines = 2
const tag = "Decision:"
// A tag in comment text; a backticked one is prose about the tag.
const anyTag = new RegExp(String.raw`(?<!\`)\b${tag}`)
const script = /\.[cm]?[jt]sx?$/
const jsx = /\.[jt]sx$/
const json = /\.jsonc?$/
const yaml = /\.ya?ml$/
const shell = /\.sh$/
const css = /\.css$/
// A path to an ADR file: `docs/adr/` under any directories, then a numbered
// name, so a `NNNN-slug.md` placeholder is prose. A path that starts partway
// along another, as in a URL or `<workspace>/docs/adr/`, is not read.
const adrPath =
  /(?<![\w@./:-])(?:[\w@.-]+\/)*docs\/adr\/\d{4}-[\w.-]*\.md(?![\w-])/g

// A path written from its file's directory. A Markdown link may be one; a
// Decision pointer may not.
const fromFile = /^\.\.?\//

// A file in an ADR directory: the directory, and the name below it.
const adrFile = /^((?:.*\/)?docs\/adr)\/(.+)$/
// An ADR's name, and its number.
const adrName = /^(\d{4})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/

// An ADR path as written, and the 1-based line it is on.
interface Link {
  readonly line: number
  readonly written: string
}

// The ADR paths in `lines`, the first of which is line `first`.
const linksIn = Effect.fnUntraced(function* (
  lines: ReadonlyArray<string>,
  first: number
) {
  return lines.flatMap((text, index) =>
    Array.from(text.matchAll(adrPath), ([written]): Link => ({
      line: first + index,
      written,
    }))
  )
})

// A comment as a parser reports it: its text, after `//` or `#` or between
// `/*` and `*/`, and the offset where it opens.
interface Found {
  readonly block: boolean
  readonly start: number
  readonly value: string
}

// The comments that open a line with `marker`: `#` in shell, and in a YAML
// block scalar `#` (a `run:` script) or `//` (github-script).
const lineComments = Effect.fnUntraced(function* (
  text: string,
  marker: string
) {
  let offset = 0
  return text.split("\n").flatMap((line): Array<Found> => {
    const start = offset
    offset += line.length + 1
    const at = line.length - line.trimStart().length
    return line.trimStart().startsWith(marker)
      ? [
          {
            block: false,
            start: start + at,
            value: line.slice(at + marker.length),
          },
        ]
      : []
  })
})

const cssComments = Effect.fnUntraced(function* (text: string) {
  return Array.from(text.matchAll(/\/\*([\s\S]*?)\*\//g), (match): Found => ({
    block: true,
    start: match.index,
    value: match[1] ?? "",
  }))
})

// The comments in a file: empty when it is not a type with comments, none when
// oxc cannot parse it. The check then names the file and reads nothing from it.
const readComments = Effect.fnUntraced(function* (file: string, text: string) {
  const oxc = (name: string, source: string, shift: number) => {
    const { errors, comments } = parseSync(name, source)
    return errors.length > 0
      ? Option.none()
      : Option.some(
          comments.map((comment) => ({
            block: comment.type === "Block",
            start: comment.start - shift,
            value: comment.value,
          }))
        )
  }
  // CST tokens nest; every comment is a `comment` token somewhere in them.
  const yamlComments = (node: unknown): ReadonlyArray<Found> => {
    if (typeof node !== "object" || node === null) return []
    if ("type" in node && node.type === "comment" && "source" in node)
      return [
        {
          block: false,
          start: "offset" in node ? Number(node.offset) : 0,
          value: String(node.source).slice(1),
        },
      ]
    return Object.values(node).flatMap(yamlComments)
  }
  if (script.test(file)) return oxc(file, text, 0)
  // JSON with comments is a JS expression once wrapped in parentheses; the
  // newline keeps a closing line comment from taking the `)`.
  if (json.test(file)) return oxc(`${file}.js`, `(${text}\n)`, 1)
  if (yaml.test(file)) {
    // A block scalar is a string to the parser; add its full-line `#` and
    // `//` comments, each once.
    const parsed = yamlComments([...new Parser().parse(text)])
    const seen = new Set(parsed.map(({ start }) => start))
    const embedded = [
      ...(yield* lineComments(text, "#")),
      ...(yield* lineComments(text, "//")),
    ].filter(({ start }) => !seen.has(start))
    return Option.some(
      [...parsed, ...embedded].sort((a, b) => a.start - b.start)
    )
  }
  if (shell.test(file)) return Option.some(yield* lineComments(text, "#"))
  if (css.test(file)) return Option.some(yield* cssComments(text))
  return Option.some([])
})

// A comment laid over its source lines. `opens` when only whitespace, or in a
// JSX file a `{`, sits before it on its line. A run of `//` or `#` comments on
// consecutive lines, each opening its line, is one comment.
interface Comment {
  readonly line: number
  readonly opens: boolean
  readonly block: boolean
  readonly lines: Array<string>
}

// A file's comments laid over its source lines.
const layComments = Effect.fnUntraced(function* (
  file: string,
  text: string,
  found: ReadonlyArray<Found>
) {
  return found.reduce<Array<Comment>>((all, { block, start, value }) => {
    const line = text.slice(0, start).split("\n").length - 1
    const before = text.slice(text.lastIndexOf("\n", start - 1) + 1, start)
    const opens = (jsx.test(file) ? /^\s*\{?\s*$/ : /^\s*$/).test(before)
    const lines = value
      .split("\n")
      .map((part) => (block ? part.replace(/^\s*\*?/, "") : part).trim())
    const last = all.at(-1)
    if (
      last !== undefined &&
      !block &&
      !last.block &&
      opens &&
      last.opens &&
      last.line + last.lines.length === line
    )
      last.lines.push(...lines)
    else all.push({ line, opens, block, lines })
    return all
  }, [])
})

// What the decision whose tag is on `lines[index]` of `comment` breaks:
// sitting partway along a line, running too long, naming no ADR, naming one
// by a path from its file. Also the ADR paths it names.
const judgeDecision = Effect.fnUntraced(function* (
  file: string,
  { line, opens, lines }: Comment,
  index: number
) {
  const at = `${file}:${line + index + 1}`
  const part = lines[index] ?? ""
  if (!opens || !part.startsWith(tag))
    return {
      findings: [
        `${at}: ${tag} sits partway along a line; open a comment line with it`,
      ],
      pointers: [],
    }
  // It runs to the end of its comment or an empty comment line.
  const end = lines.findIndex((each, after) => after > index && each === "")
  const length = (end < 0 ? lines.length : end) - index
  const pointers = yield* linksIn(
    lines.slice(index, index + length),
    line + index + 1
  )
  return {
    findings: [
      ...(length > maxDecisionLines
        ? [
            `${at}: Decision runs ${length} lines; keep ${maxDecisionLines}: a gist and the ADR path`,
          ]
        : []),
      ...(pointers.length === 0
        ? [`${at}: Decision names no ADR; add its docs/adr/NNNN-slug.md path`]
        : []),
      ...pointers.flatMap(({ line: on, written }) =>
        fromFile.test(written)
          ? [
              `${file}:${on}: Decision points at ${written}, a path from its file; write it from the repo root`,
            ]
          : []
      ),
    ],
    pointers,
  }
})

// What a file's `Decision:` comments break, and the ADR paths they name.
const decisionFindings = Effect.fnUntraced(function* (
  file: string,
  text: string,
  found: ReadonlyArray<Found>
) {
  const comments = yield* layComments(file, text, found)
  const judged = yield* Effect.forEach(
    comments.flatMap((comment) =>
      comment.lines.flatMap((part, index) =>
        anyTag.test(part) ? [{ comment, index }] : []
      )
    ),
    ({ comment, index }) => judgeDecision(file, comment, index)
  )
  return {
    findings: judged.flatMap(({ findings }) => findings),
    pointers: judged.flatMap(({ pointers }) => pointers),
  }
})

export const checkDecisionDocs = Effect.fn("checkDecisionDocs")(function* (
  root: string
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const files = yield* gitLines(root, [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "--",
    // repos/ is vendored upstream source, which may keep ADRs of its own.
    ":(exclude)repos",
  ])
  const read = yield* Effect.forEach(files, (file) =>
    Effect.gen(function* () {
      // A listed file may be deleted from the working tree.
      const text = yield* Effect.option(
        fs.readFileString(path.resolve(root, file))
      )
      if (Option.isNone(text)) return Option.none()
      if (text.value.includes("\0"))
        return Option.some({
          file,
          text: "",
          shape: [],
          links: [],
          pointers: [],
        })
      const links = yield* linksIn(text.value.split("\n"), 1)
      const found = yield* readComments(file, text.value)
      if (Option.isNone(found))
        yield* Console.error(
          `${file}: does not parse, so no Decision in it was read`
        )
      const { findings: shape, pointers } = Option.isSome(found)
        ? yield* decisionFindings(file, text.value, found.value)
        : { findings: [], pointers: [] }
      return Option.some({ file, text: text.value, shape, links, pointers })
    })
  )
  const present = read.flatMap(Option.toArray)
  const exists = new Set(present.map(({ file }) => file))
  // A path that starts `./` or `../` is from its file's directory; any other
  // is from the repo root.
  const target = (file: string, written: string) =>
    fromFile.test(written)
      ? path.join(path.dirname(file), written)
      : path.normalize(written)
  // The `Key: value` lines between an opening and a closing `---`, keyed in
  // lower case.
  const frontmatter = (text: string) => {
    const end = text.startsWith("---\n") ? text.indexOf("\n---", 3) : -1
    return new Map(
      (end < 0 ? [] : text.slice(4, end).split("\n")).flatMap((line) => {
        const [, key, value] = /^(\w+):\s*(.*?)\s*$/.exec(line) ?? []
        return key === undefined || value === undefined
          ? []
          : [[key.toLowerCase(), value] as const]
      })
    )
  }

  // The backticked paths in the body's `Sites:` list, or nothing when the
  // body has no list.
  const sitesListed = (text: string) => {
    const list = /^Sites:\n((?:- .*(?:\n|$))+)/m.exec(text)?.[1]
    return list === undefined
      ? undefined
      : [...list.matchAll(/`([^`]+)`/g)].flatMap(([, site]) =>
          site === undefined ? [] : [site]
        )
  }

  const adrs = present.flatMap(({ file, text }) => {
    const [, dir, name] = adrFile.exec(file) ?? []
    if (dir === undefined || name === undefined) return []
    const fields = frontmatter(text)
    const successor = /^superseded by ADR-(\d{4})$/i.exec(
      fields.get("status") ?? ""
    )?.[1]
    return [
      {
        file,
        dir,
        name,
        number: adrName.exec(name)?.[1],
        siteless: fields.get("sites")?.toLowerCase() === "none",
        successor,
        sites: sitesListed(text),
        sourced: /^Source: \S/m.test(text),
      },
    ]
  })
  const byFile = new Map(adrs.map((adr) => [adr.file, adr]))
  // The ADR that replaced a superseded one, by path when it is in the same
  // directory.
  const replacement = (dir: string, number: string) =>
    adrs.find((adr) => adr.dir === dir && adr.number === number)?.file ??
    `ADR-${number}`

  const named = adrs.flatMap(({ number, ...adr }) =>
    number === undefined ? [] : [{ ...adr, number }]
  )
  // Each ADR, by path, and the files whose pointers name it.
  const holders = new Map<string, Set<string>>()
  for (const { file, pointers } of present)
    for (const { written } of pointers) {
      const adr = target(file, written)
      holders.set(adr, (holders.get(adr) ?? new Set()).add(file))
    }
  const pointed = new Set(holders.keys())
  const findings = [
    ...present.flatMap(({ file, shape, links, pointers }) => [
      ...shape,
      ...links.flatMap(({ line, written }) =>
        exists.has(target(file, written))
          ? []
          : [`${file}:${line}: points at ${written}, which does not exist`]
      ),
      ...pointers.flatMap(({ line, written }) => {
        const adr = byFile.get(target(file, written))
        return adr?.successor === undefined
          ? []
          : [
              `${file}:${line}: points at ${written}, superseded by ${replacement(adr.dir, adr.successor)}; point there`,
            ]
      }),
    ]),
    ...adrs.flatMap(({ file, number }) =>
      number === undefined ? [`${file}: name it NNNN-<slug>.md`] : []
    ),
    // Named once, at the first ADR holding the number.
    ...named.flatMap((adr) => {
      const same = named.filter(
        ({ dir, number }) => dir === adr.dir && number === adr.number
      )
      if (same[0] !== adr || same.length < 2) return []
      const names = same.map(({ name }) => name)
      return [
        `${adr.dir}: ADR number ${adr.number} is used by ${names.slice(0, -1).join(", ")} and ${names.at(-1)}; renumber one`,
      ]
    }),
    // A superseded ADR has had its pointers moved to its successor.
    ...named.flatMap(({ file, siteless, successor }) =>
      siteless || successor !== undefined || pointed.has(file)
        ? []
        : [
            `${file}: no Decision points here; add a pointer at its site, or mark it Sites: none`,
          ]
    ),
    ...named.flatMap(({ file, sourced }) =>
      sourced
        ? []
        : [
            `${file}: add a Source: line naming its issue or PR, or Source: none`,
          ]
    ),
    // A siteless ADR's list names the files that enact it without a pointer,
    // and a superseded one's the sites it had before they moved. An ADR no
    // pointer reaches is reported above.
    ...named.flatMap(({ file, sites, siteless, successor }) => {
      const held = [...(holders.get(file) ?? [])].sort()
      if (siteless || successor !== undefined || held.length === 0) return []
      if (sites === undefined)
        return [`${file}: add a Sites: list naming ${held.join(", ")}`]
      return [
        ...held
          .filter((site) => !sites.includes(site))
          .map((site) => `${file}: ${site} points here; add it to Sites`),
        ...sites
          .filter((site) => !held.includes(site))
          .map(
            (site) =>
              `${file}: Sites lists ${site}, which holds no Decision pointing here; drop it`
          ),
      ]
    }),
  ]
  if (findings.length > 0)
    return yield* new CheckFailed({
      summary:
        "This repo records decisions as ADRs, each reached by a two-line `Decision:` pointer at its sites (docs/agents/domain.md):",
      findings,
    })
  yield* Console.log(
    `Checked ${files.length} files: every Decision points at an ADR, every ADR has one.`
  )
})
