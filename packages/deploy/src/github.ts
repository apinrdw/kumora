// The repo reads the Preview sweep needs, over GitHub's GraphQL API. In the
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

const Branch = Schema.Struct({
  name: Schema.String,
  headCommitDate: Schema.DateTimeUtc,
  // open: a PR from this branch is open. closed: it had PRs, none is open, so
  // its latest is merged or closed. none: it never had a PR.
  pullRequests: Schema.Literals(["open", "closed", "none"]),
})
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

// One query per 100 branches, each with its head commit date and PR counts.
// REST would list branches with only a sha, then take a call per branch for
// its commit date, plus a paged listing of every PR the repo ever had.
// associatedPullRequests holds the PRs whose head is this branch of this
// repo, so a fork's same-named branch never counts.
const QUERY = `query ($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    refs(refPrefix: "refs/heads/", first: ${PER_PAGE}, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        name
        target { ... on Commit { committedDate } }
        open: associatedPullRequests(states: OPEN) { totalCount }
        all: associatedPullRequests { totalCount }
      }
    }
  }
}`

const Count = Schema.Struct({ totalCount: Schema.Number })

const Refs = Schema.Struct({
  pageInfo: Schema.Struct({
    hasNextPage: Schema.Boolean,
    endCursor: Schema.NullOr(Schema.String),
  }),
  nodes: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      target: Schema.Struct({ committedDate: Schema.DateTimeUtcFromString }),
      open: Count,
      all: Count,
    })
  ),
})

// GraphQL answers 200 with `errors` when the query fails.
const Response = Schema.Struct({
  data: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        repository: Schema.NullOr(Schema.Struct({ refs: Refs })),
      })
    )
  ),
  errors: Schema.optionalKey(
    Schema.Array(Schema.Struct({ message: Schema.String }))
  ),
})

const branches = Effect.gen(function* () {
  const repository = yield* Config.String("GITHUB_REPOSITORY")
  const token = yield* Config.Redacted("GITHUB_TOKEN")
  const [owner, name] = repository.split("/")
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.mapRequest((request) =>
      request.pipe(
        HttpClientRequest.acceptJson,
        HttpClientRequest.bearerToken(Redacted.value(token))
      )
    ),
    HttpClient.filterStatusOk
  )
  const all: Array<Branch> = []
  let after: string | null = null
  for (;;) {
    const request = yield* HttpClientRequest.post(
      "https://api.github.com/graphql"
    ).pipe(
      HttpClientRequest.bodyJson({
        query: QUERY,
        variables: { owner, name, after },
      })
    )
    const response: typeof Response.Type = yield* client
      .execute(request)
      .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(Response)))
    const refs = response.data?.repository?.refs
    if (refs === undefined)
      return yield* new GitHubError({
        cause: (response.errors ?? [{ message: `no repository ${repository}` }])
          .map((error) => error.message)
          .join("; "),
      })
    all.push(
      ...refs.nodes.map((ref): Branch => ({
        name: ref.name,
        headCommitDate: ref.target.committedDate,
        pullRequests:
          ref.open.totalCount > 0
            ? "open"
            : ref.all.totalCount > 0
              ? "closed"
              : "none",
      }))
    )
    if (!refs.pageInfo.hasNextPage) return all
    after = refs.pageInfo.endCursor
  }
}).pipe(
  Effect.mapError((cause) =>
    cause instanceof GitHubError ? cause : new GitHubError({ cause })
  ),
  Effect.provide(FetchHttpClient.layer)
)

export class GitHub extends Context.Service<
  GitHub,
  {
    // Every live branch of the repo, with its head commit date and PRs.
    readonly branches: Effect.Effect<ReadonlyArray<Branch>, GitHubError>
  }
>()("@workspace/deploy/GitHub") {
  static readonly layer = Layer.succeed(this, { branches })
}
