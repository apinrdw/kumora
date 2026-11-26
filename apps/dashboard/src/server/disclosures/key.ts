// What names a disclosure, and where the disclosure archive keeps it in its
// bucket (DISCLOSURE_ARCHIVE_BUCKET in alchemy.run.ts):
//
//   disclosures/<key>/<language>.json        a disclosure version, as listed
//   disclosures/<key>/files/<path>           an attachment, once per path
//   runs/                                    never written: ArchiveDb holds
//                                            the runs from the first
//
// `<key>` is the disclosure key, URI-encoded (it holds slashes), and
// `<path>` the attachment's path on IDX's site without its leading slash.
// Nothing under disclosures/ is ever overwritten or deleted.
import { Effect, Schema } from "effect"

// The language of a disclosure version, as IDX's `lang` parameter takes it.
export const DisclosureLanguage = Schema.Literals(["id", "en"])
export type DisclosureLanguage = typeof DisclosureLanguage.Type

// IDX's `Id2` ends in the version's language.
const ID2_SUFFIX: Record<DisclosureLanguage, string> = {
  id: "_id-id",
  en: "_en-us",
}

// IDX's `Id2` without its language suffix: when the disclosure was
// published (YYYYMMDDHHmmss, in WIB), a dash, and its number, such as
// `20261124230949-02894/FMS/OPS-BTIM/XI/26`.
export const DisclosureKey = Schema.String.check(
  Schema.isPattern(/^\d{14}-.+$/)
).pipe(Schema.brand("DisclosureKey"))
export type DisclosureKey = typeof DisclosureKey.Type

// The disclosure key of a version IDX lists in `language`; undefined when
// its `Id2` doesn't end in that language's suffix or has no publish time.
// Decision: a disclosure is keyed by IDX's Id2 without its language
// (apps/dashboard/docs/adr/0136-a-disclosure-is-keyed-by-id2-without-its-language.md)
export const disclosureKeyOf = Effect.fnUntraced(function* (
  id2: string,
  language: DisclosureLanguage
) {
  const suffix = ID2_SUFFIX[language]
  if (!id2.endsWith(suffix)) return undefined
  const key = id2.slice(0, -suffix.length)
  return Schema.is(DisclosureKey)(key) ? key : undefined
})

const DISCLOSURES_PREFIX = "disclosures/"

const disclosurePrefix = Effect.fnUntraced(function* (key: DisclosureKey) {
  return `${DISCLOSURES_PREFIX}${encodeURIComponent(key)}/`
})

export const versionKey = Effect.fnUntraced(function* (
  key: DisclosureKey,
  language: DisclosureLanguage
) {
  return `${yield* disclosurePrefix(key)}${language}.json`
})

// `path` is the attachment's path on IDX's site, as `/StaticData/…/x.pdf`.
export const attachmentKey = Effect.fnUntraced(function* (
  key: DisclosureKey,
  path: string
) {
  return `${yield* disclosurePrefix(key)}files/${path.replace(/^\/+/, "")}`
})
