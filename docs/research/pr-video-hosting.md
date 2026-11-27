# Where to host a local e2e video so it plays inline on a GitHub PR

Research for [#201](https://github.com/apinrdw/kumora/issues/201), map [#200](https://github.com/apinrdw/kumora/issues/200). Read 2026-11-12 against `gh` 2.103.3 (latest; 2.96.0 is installed locally), Playwright 1.64.1, and docs.github.com / developers.cloudflare.com as of that date.

## Answer

- **Use GitHub's own attachment upload, driven by `gh ... --attach` (gh ≥ 2.99.0).** It is the only option that renders as an inline player. It is official and scriptable, it accepts `.webm` as Playwright writes it, the file is visible only to people with access to the repo when the repo is private (`apinrdw/kumora` is `PRIVATE`), and the URL does not depend on the PR, the branch or any comment staying around.
  ```shell
  gh pr comment <PR> --body-file evidence.md --attach apps/e2e/test-results/<spec>/video.webm
  ```
  In `evidence.md`, put `![](apps/e2e/test-results/<spec>/video.webm)` alone in its own paragraph. `gh` rewrites it to the uploaded URL, and a bare URL on its own line renders as a player. A video you attach but do not reference is appended as a bare URL, which also plays.
- **The other three options do not play inline.** GitHub states that it "does not support externally hosted videos". That rules out R2. An orphan-branch raw/blob URL and a release-asset URL render as plain links: a reviewer clicks through, and in a private repo they need to be logged in.
- **Watch the size cap.** The video limit is **10 MB when the repo owner is on a free plan** and 100 MB on a paid plan. Playwright's VP9 at the default 800x450 aims for about 1 Mbit/s (around 7.5 MB/minute), so on a free plan a single video tops out at roughly 80 s. Split long specs or re-encode them. `gh` has no chunking.
- **`.webm` uploads and plays, but GitHub recommends H.264 for the widest browser support.** Playwright only writes VP9 `.webm`. If reviewers use Safari/iOS, an `ffmpeg -i video.webm -c:v libx264 -pix_fmt yuv420p video.mp4` step is the safe default. The `apinrdw` plan tier could not be read with the current token (`plan: null`), so the 10 MB versus 100 MB question is still open.

|                                      | Inline player in PR                             | Formats                                   | Size limit                                 | Upload auth                                                 | Private-repo viewers                                                                                        | Survives merge / close / branch delete                                                  |
| ------------------------------------ | ----------------------------------------------- | ----------------------------------------- | ------------------------------------------ | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| **`gh --attach` (user-attachments)** | **Yes**: bare URL on its own line               | `.mp4` `.mov` `.webm` (H.264 recommended) | 10 MB video (free owner) / 100 MB (paid)   | `gh auth login` OAuth token or classic PAT, **push access** | Only people with repo access; served through short-lived signed URLs                                        | Yes. Stored apart from the comment; removed only through Support                        |
| Orphan branch (raw/blob URL)         | No, link only                                   | any                                       | Git: 100 MB/file hard limit, 50 MB warning | push                                                        | Logged-in users with access (raw URL needs a token)                                                         | Yes while the orphan branch lives; adds history to the repo forever unless force-pushed |
| Release assets                       | No, link only                                   | any                                       | < 2 GiB per file, 1000 per release         | push (write)                                                | Users with read access; anonymous download fails on a private repo                                          | Yes while the release lives; a release (or one per PR) shows in the Releases list       |
| Cloudflare R2                        | No, link only (and `<video>` tags are stripped) | any                                       | 5 TiB/object                               | R2 API token (from Infisical)                               | **Anyone with the URL** unless you add Cloudflare Access, and then the reviewer has to log in to Access too | Yes; lifecycle rules can expire objects                                                 |

## Sources and evidence

### GitHub attachments (`user-attachments`)

- [Attaching files](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/attaching-files) ([source](https://github.com/github/docs/blob/main/content/get-started/writing-on-github/working-with-advanced-formatting/attaching-files.md)):
  - "In the case of private and internal repositories, only people with access to the repository can view the uploaded files."
  - "You can also attach local images and videos from the command line with GitHub CLI."
  - Limits: "10MB for videos uploaded to a repository owned by a user or organization on a free GitHub plan" and "100MB for videos uploaded to a repository owned by a user or organization on a paid GitHub plan".
  - Supported: "Video (`.mp4`, `.mov`, `.webm`)", plus "Video codec compatibility is browser specific … At the moment we recommend using H.264 for greatest compatibility."
- [Attaching files with GitHub CLI](https://docs.github.com/en/github-cli/github-cli/attaching-files-with-github-cli):
  - `--attach` works on `gh issue create|edit|comment` and `gh pr create|edit|comment`.
  - "You need push access to the repository to attach files."
  - "To embed a video as a player, save the following Markdown image reference … `![](PATH/TO/VIDEO)` … The reference must be the only content in its paragraph." … "If the reference appears within a sentence, it renders as a link instead."
- [Changelog 2026-09-01, GitHub CLI: media in issues, pull requests and comments](https://github.blog/changelog/2026-09-01-github-cli-media-in-issues-pull-requests-and-comments/):
  - Generally available on all plans, GitHub Enterprise Server not supported. Needs gh v2.99.0.
  - "Size limits match the web upload flow."
  - Works with the `gh auth login` OAuth token and classic PATs.
  - [gh v2.99.0 release notes](https://github.com/cli/cli/releases/tag/v2.99.0) introduce the flag. v2.102.0 and v2.103.2 extend it to some `ghu_` and GitHub App installation tokens, with the server deciding which are allowed.
- `cli/cli` source (`internal/attachments/`):
  - `client.go` posts the raw bytes to `https://uploads.github.com/user-attachments/assets?name=…&content_type=…&repository_id=…` and reads back `url`. This endpoint is not in the REST docs. `gh` is the supported client for it, so script through `gh` and not the raw endpoint.
  - `userasset.go` maps `.webm` to `video/webm` and caps videos client-side at `100 * 1024 * 1024`. The server applies the plan's 10 MB limit.
  - `attach.go`: "a video appends a bare URL so that it plays."
- [About anonymized URLs](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/about-anonymized-urls):
  - "GitHub does not support externally hosted videos, so the anonymized URL is a link to the uploaded video hosted by GitHub."
  - "Files and images hosted under `github.com/user-attachments/` are separate from the comments and pull request descriptions that link to them. Removing a link … does not necessarily delete the uploaded file."
  - Deleting one takes a GitHub Support request. There is no API or CLI delete, so retention (#200's "Video retention") can't be scripted.
- Rendered-HTML evidence (`gh api -H 'Accept: application/vnd.github.html+json' …`, which is what github.com serves):
  - [microsoft/playwright#43999](https://github.com/microsoft/playwright/issues/43999) has a body line that is only `https://github.com/user-attachments/assets/67734ccb-…`. It renders as `<video src="https://private-user-images.githubusercontent.com/…mp4?jwt=…" controls muted …>`, and #43833 does the same for a `.mov`.
  - The `jwt`/`X-Amz-Expires=300` on that `src` shows GitHub signs a short-lived URL per page view.
  - The same bare-URL form from 2022 ([cli/cli#6254](https://github.com/cli/cli/pull/6254), a merged PR whose branch is gone) still renders a player. That is evidence the URL outlives merge and branch deletion.

### Orphan branch, release assets, R2 (no inline player)

- Primary statement: "GitHub does not support externally hosted videos" (above). The only documented way to get a player is an uploaded attachment.
- Local render check with `gh api -X POST markdown -f mode=gfm -f context=apinrdw/kumora` (renders without posting anything):
  - Bare `…/raw/…webm`, `raw.githubusercontent.com/…mp4`, `…/releases/download/…mp4` and `pub-….r2.dev/…mp4` URLs each came back as a plain `<a>`.
  - `<video src="…">` came back as an empty `<p>`: the sanitizer strips the tag whatever the `src`.
  - `![](https://…r2.dev/….mp4)` became a Camo `<img>`, which shows as a broken image.
  - Caveat: this endpoint doesn't add the video player even for a `user-attachments` URL, because the player is applied to stored comments. Treat it as evidence for "link" and "stripped", not as proof that a player is never added. The doc statement above settles that.
- Release assets: [About releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases) gives "Each file included in a release must be under 2 GiB" and "Up to 1000 release assets". [Release assets REST](https://docs.github.com/en/rest/releases/assets) uploads to `uploads.github.com/repos/OWNER/REPO/releases/RELEASE_ID/assets` with push access. Downloading from a private repo needs a token (`Accept: application/octet-stream`).
- Orphan branch: [About large files on GitHub](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github) gives a 50 MB warning and a 100 MB block per file. Every video becomes a permanent Git object in a private repo that Workers Builds also clones (see AGENTS.md "Deploys"), so it grows clone size unless you rewrite history.
- R2: [Public buckets](https://developers.cloudflare.com/r2/buckets/public-buckets/) says "Public access through `r2.dev` subdomains is rate-limited and should only be used for development purposes". A custom domain plus Cloudflare Access is the documented way to restrict access, and a reviewer would then hit an Access login instead of a player. [Object lifecycles](https://developers.cloudflare.com/r2/buckets/object-lifecycles/) can expire objects. Uploading is scriptable (`wrangler r2 object put`, S3 API), but the link-only result fails the inline requirement.

### Playwright output

- `packages/playwright-core/src/server/videoRecorder.ts` at v1.64.1:
  - Output must end in `.webm` ("File must have .webm extension").
  - The encoder is `libvpx-vp9` with `-b:v 1M` "for the default 800x450 video at 25fps", scaled with pixel rate for larger sizes.
  - That puts a free-plan 10 MB video at roughly 80 s. A larger `recordVideo.size` costs proportionally more.

## Open for the spec

- Confirm whether `apinrdw` is on a paid plan (10 MB versus 100 MB per video). `gh api user` returned `plan: null` with the current token scopes. Check `github.com/settings/billing`.
- Developers need `gh` ≥ 2.99.0 (the installed one is 2.96.0). The evidence script should check `gh --version`.
- Coding agents need a token that `--attach` accepts: the OAuth token from `gh auth login` or a classic PAT. Fine-grained PATs are not listed in the changelog.
- Decide whether to transcode to H.264 `.mp4` (Safari/iOS reviewers), which also makes the file smaller.
- The CI evidence gate (#203) can look for a `github.com/user-attachments/assets/` URL in PR comments through `gh api`.
