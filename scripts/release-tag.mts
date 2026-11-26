// Judges a Release tag, v<version>-<YYYYMMDD>, for
// .github/workflows/release.yml. The owner pushes one on a staging commit
// whose Release version it names, then publishes a GitHub Release on it,
// which promotes that commit to Production.
import { Console, Effect, Schema } from "effect"

import { CheckFailed } from "./lib/check.mts"
import { gitLines, stdoutOf } from "./lib/command.mts"

type Version = readonly [number, number, number]

export interface TagRef {
  readonly name: string
  readonly sha: string
}

// Decision: a Release tag names the Release version, kept equal in these files
// (docs/adr/0020-a-release-tag-names-the-release-version-on-a-staging-commit.md)
export const releaseVersionFiles = [
  "package.json",
  "apps/dashboard/package.json",
  "apps/web/package.json",
] as const

const shape = /^v(\d+)\.(\d+)\.(\d+)-(\d{8})$/

export const wibDate = Effect.fnUntraced(function* (now: Date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(now)
    .replaceAll("-", "")
})

const refuse = (summary: string) =>
  Effect.fail(new CheckFailed({ summary: `Refusing ${summary}`, findings: [] }))

// `released` holds the tags on main: Production has shipped each of them.
// `versions` is each Release version file's version at the tag's commit.
// `today` is checked only when the tag is pushed; a Release may come later.
export const judgeTag = Effect.fn("judgeTag")(function* (
  tag: TagRef,
  released: ReadonlyArray<TagRef>,
  versions: ReadonlyArray<readonly [file: string, version: string]>,
  today: string | undefined
) {
  const parse = (name: string) => {
    const match = shape.exec(name)
    if (match === null) return undefined
    const [, major, minor, patch, date = ""] = match
    const version: Version = [Number(major), Number(minor), Number(patch)]
    return { version, date }
  }

  const compare = (a: Version, b: Version) =>
    a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
  const show = (version: Version) => version.join(".")

  const release = parse(tag.name)
  if (release === undefined)
    return yield* refuse(
      `${tag.name}: a Release tag is v<version>-<YYYYMMDD>. Candidate tags (-<N>) are retired.`
    )
  if (today !== undefined && release.date !== today)
    return yield* refuse(
      `${tag.name}: its date must be today in WIB, ${today}.`
    )
  const mismatched = versions.filter(
    ([, version]) => version !== show(release.version)
  )
  if (mismatched.length > 0)
    return yield* new CheckFailed({
      summary: `Refusing ${tag.name}: its commit's Release version is not ${show(release.version)}. Bump "version" in every file below on staging, then tag the bump's commit:`,
      findings: mismatched.map(([file, version]) => `${file}: ${version}`),
    })
  const production = released
    .filter((other) => other.name !== tag.name)
    .flatMap((other) => {
      const known = parse(other.name)
      return known === undefined ? [] : [known.version]
    })
    .reduce<Version | undefined>(
      (top, version) =>
        top === undefined || compare(version, top) > 0 ? version : top,
      undefined
    )
  if (production !== undefined && compare(release.version, production) <= 0)
    return yield* refuse(
      `${tag.name}: its version must be above Production's ${show(production)}.`
    )
})

const Package = Schema.fromJsonString(Schema.Struct({ version: Schema.String }))

const versionsAt = Effect.fn("versionsAt")(function* (
  root: string,
  rev: string
) {
  return yield* Effect.forEach(releaseVersionFiles, (file) =>
    stdoutOf("git", ["show", `${rev}:${file}`], { cwd: root }).pipe(
      Effect.flatMap(Schema.decodeEffect(Package)),
      Effect.map(({ version }) => [file, version] as const)
    )
  )
})

const tagRefs = Effect.fn("tagRefs")(function* (
  root: string,
  extra: ReadonlyArray<string>
) {
  return (yield* gitLines(root, [
    "for-each-ref",
    ...extra,
    "refs/tags",
    "--format=%(refname:short) %(if)%(*objectname)%(then)%(*objectname)%(else)%(objectname)%(end)",
  ])).map((line): TagRef => {
    const [name = "", sha = ""] = line.split(" ")
    return { name, sha }
  })
})

// A pushed tag is dated today; a Release on it is judged without the date.
export const checkReleaseTag = Effect.fn("checkReleaseTag")(function* (
  root: string,
  name: string,
  today: string | undefined
) {
  const tag = (yield* tagRefs(root, [])).find((ref) => ref.name === name)
  if (tag === undefined) return yield* refuse(`${name}: no such tag.`)
  yield* judgeTag(
    tag,
    yield* tagRefs(root, ["--merged", "origin/main"]),
    yield* versionsAt(root, tag.sha),
    today
  )
  yield* Console.log(`${name} names the Release version at ${tag.sha}.`)
})

export const checkReleaseVersions = Effect.fn("checkReleaseVersions")(
  function* (root: string) {
    const versions = yield* versionsAt(root, "HEAD")
    if (new Set(versions.map(([, version]) => version)).size > 1)
      return yield* new CheckFailed({
        summary:
          'The Release version differs between its files. Set the same "version" in each:',
        findings: versions.map(([file, version]) => `${file}: ${version}`),
      })
    yield* Console.log(`Release version ${versions[0]?.[1]} in every file.`)
  }
)
