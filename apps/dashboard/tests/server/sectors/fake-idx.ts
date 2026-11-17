// IDX's company profiles for tests: a stub HttpClient that answers every
// request with `profiles`, or with `response` when set, and records the URLs.
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"

interface Profile {
  readonly KodeEmiten: string
  readonly Sektor: string
  readonly SubSektor: string
  readonly Industri: string
  readonly SubIndustri: string
}

// A profile as IDX lists it, contact fields and all.
export const profile = (
  code: string,
  sector = "Energy"
): Profile & Record<string, string> => ({
  KodeEmiten: code,
  Sektor: sector,
  SubSektor: "Oil, Gas & Coal",
  Industri: "Coal",
  SubIndustri: "Coal Production",
  NamaEmiten: `PT ${code} Tbk`,
  Alamat: "Jakarta",
  Telepon: "021",
})

export const codes = (n: number, prefix = "C") =>
  Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(3, "0")}`)

interface FakeIdx {
  profiles: ReadonlyArray<Profile>
  // Answered instead of the profiles, when set.
  response: (() => Response) | undefined
  readonly requests: Array<string>
  readonly layer: Layer.Layer<HttpClient.HttpClient>
}

export const fakeIdx = () => {
  const idx: FakeIdx = {
    profiles: [],
    response: undefined,
    requests: [],
    layer: Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request, url) =>
        Effect.sync(() => {
          idx.requests.push(url.href)
          return HttpClientResponse.fromWeb(
            request,
            idx.response?.() ??
              Response.json({
                draw: 0,
                recordsTotal: idx.profiles.length,
                recordsFiltered: idx.profiles.length,
                data: idx.profiles,
              })
          )
        })
      )
    ),
  }
  return idx
}
