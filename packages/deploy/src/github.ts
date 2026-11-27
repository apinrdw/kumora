// The repo reads the Preview sweep needs, over GitHub's REST API. In the
// teardown workflow GITHUB_REPOSITORY and the job's GITHUB_TOKEN set both;
// they are read per call, so the stage and destroy commands never need them.
import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/http"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"

const Branch = Schema.Struct({ name: Schema.String })
export type Branch = typeof Branch.Type

class GitHubError extends Schema.TaggedError<GitHubError>()("GitHubError", {
  cause: Schema.Defect(),
}) {
  override get message() {
    return `Reading GitHub failed: ${String(this.cause)}`
  }
}

// GitHub's largest page.
const PER_PAGE = 100

const branches = Effect.gen(function* () {
  const repository = yield* Config.String("GITHUB_REPOSITORY")
  const token = yield* Config.Redacted("GITHUB_TOKEN")
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.mapRequest((request) =>
      request.pipe(
        HttpClientRequest.prependUrl(
          `https://api.github.com/repos/${repository}`
        ),
        HttpClientRequest.acceptJson,
        HttpClientRequest.bearerToken(Redacted.value(token))
      )
    ),
    HttpClient.filterStatusOk
  )
  const all: Array<Branch> = []
  for (let page = 1; ; page++) {
    const batch = yield* client
      .get("/branches", {
        urlParams: { per_page: String(PER_PAGE), page: String(page) },
      })
      .pipe(
        Effect.flatMap(HttpClientResponse.schemaBodyJson(Schema.Array(Branch)))
      )
    all.push(...batch)
    if (batch.length < PER_PAGE) return all
  }
}).pipe(
  Effect.mapError((cause) => new GitHubError({ cause })),
  Effect.provide(FetchHttpClient.layer)
)

export class GitHub extends Context.Service<
  GitHub,
  {
    // Every live branch of the repo.
    readonly branches: Effect.Effect<ReadonlyArray<Branch>, GitHubError>
  }
>()("@workspace/deploy/GitHub") {
  static readonly layer = Layer.succeed(this, { branches })
}
