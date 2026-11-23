// Judges a release tag for .github/workflows/release.yml. A Candidate,
// v<version>-<YYYYMMDD>-<N>, marks a staging commit tried on Staging; a
// Production tag, v<version>-<YYYYMMDD>, is the tag of a Release, which
// promotes a Candidate's commit.
import { Console, Effect } from "effect"

import { CheckFailed } from "./lib/check.mts"
import { gitLines } from "./lib/command.mts"

type Version = readonly [number, number, number]

type ReleaseTag =
  | {
      readonly kind: "candidate"
      readonly version: Version
      readonly date: string
      readonly n: number
    }
  | {
      readonly kind: "production"
      readonly version: Version
      readonly date: string
    }

export interface TagRef {
  readonly name: string
  readonly sha: string
}

const shape = /^v(\d+)\.(\d+)\.(\d+)-(\d{8})(?:-([1-9]\d*))?$/

// Decision: N counts every Candidate ever tagged; refused tags are deleted
// (docs/adr/0008-candidate-numbers-count-every-candidate-ever-tagged.md)
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

export const judgeTag = Effect.fn("judgeTag")(function* (
  tag: TagRef,
  others: ReadonlyArray<TagRef>,
  today: string
) {
  const parse = (name: string): ReleaseTag | undefined => {
    const match = shape.exec(name)
    if (match === null) return undefined
    const [, major, minor, patch, date = "", n] = match
    const version: Version = [Number(major), Number(minor), Number(patch)]
    return n === undefined
      ? { kind: "production", version, date }
      : { kind: "candidate", version, date, n: Number(n) }
  }
  const compare = (a: Version, b: Version) =>
    a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
  const show = (version: Version) => version.join(".")

  const release = parse(tag.name)
  if (release === undefined)
    return yield* refuse(
      `${tag.name}: a release tag is v<version>-<YYYYMMDD>-<N> (Candidate) or v<version>-<YYYYMMDD> (Production).`
    )
  if (release.date !== today)
    return yield* refuse(
      `${tag.name}: its date must be today in WIB, ${today}.`
    )
  const parsed = others.flatMap((other) => {
    const known = parse(other.name)
    return known === undefined ? [] : [{ ...known, sha: other.sha }]
  })
  const released = parsed
    .filter((known) => known.kind === "production")
    .map((known) => known.version)
    .reduce<Version | undefined>(
      (top, version) =>
        top === undefined || compare(version, top) > 0 ? version : top,
      undefined
    )
  if (released !== undefined && compare(release.version, released) <= 0)
    return yield* refuse(
      `${tag.name}: its version must be above Production's ${show(released)}.`
    )
  if (release.kind === "candidate") {
    // Decision: N counts every Candidate ever tagged; refused tags are deleted
    // (docs/adr/0008-candidate-numbers-count-every-candidate-ever-tagged.md)
    const next =
      Math.max(
        0,
        ...parsed.flatMap((known) =>
          known.kind === "candidate" ? [known.n] : []
        )
      ) + 1
    if (release.n !== next)
      return yield* refuse(`${tag.name}: the next Candidate is -${next}.`)
  } else if (
    !parsed.some(
      (known) =>
        known.kind === "candidate" &&
        known.sha === tag.sha &&
        compare(known.version, release.version) === 0
    )
  )
    return yield* refuse(
      `${tag.name}: its commit carries no v${show(release.version)} Candidate tag. Tag the commit as a Candidate and try it on Staging first.`
    )
  return release.kind
})

// Prints kind=candidate or kind=production for the workflow's output.
export const checkReleaseTag = Effect.fn("checkReleaseTag")(function* (
  root: string,
  name: string,
  today: string
) {
  const refs = (yield* gitLines(root, [
    "for-each-ref",
    "refs/tags",
    "--format=%(refname:short) %(if)%(*objectname)%(then)%(*objectname)%(else)%(objectname)%(end)",
  ])).map((line) => {
    const [refName = "", sha = ""] = line.split(" ")
    return { name: refName, sha }
  })
  const tag = refs.find((ref) => ref.name === name)
  if (tag === undefined) return yield* refuse(`${name}: no such tag.`)
  const kind = yield* judgeTag(
    tag,
    refs.filter((ref) => ref.name !== name),
    today
  )
  yield* Console.log(`kind=${kind}`)
})
