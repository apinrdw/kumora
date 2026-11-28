// Decision: e2e runs on GitHub's free runners; local evidence is video only
// (docs/adr/0024-e2e-runs-on-github-s-free-runners-and-local-evidence-is-video-only.md)

/**
 * The switch a CI job sets to run part of the suite:
 * `E2E_PROJECTS=<project>,<project>`, by the names in playwright.config.ts.
 * .github/workflows/e2e.yml sets it, so change the two together.
 */
export const PROJECTS_SWITCH = "E2E_PROJECTS"

/** The project every other waits on: it signs up the shared accounts. */
const SETUP = "setup"

type Pattern = RegExp | string

interface Project {
  readonly name: string
  readonly dependencies?: ReadonlyArray<string>
  readonly testMatch?: Pattern | ReadonlyArray<Pattern>
  readonly testIgnore?: Pattern | ReadonlyArray<Pattern>
}

const patterns = (value: Pattern | ReadonlyArray<Pattern> | undefined) =>
  value === undefined ? [] : Array.isArray(value) ? value : [value as Pattern]

// Whether a project runs a file under tests/, named as the config's own
// patterns name them: by its file name. A project with no testMatch runs
// every spec it does not ignore.
const runs = (project: Project, file: string) => {
  const hits = (pattern: Pattern) =>
    typeof pattern === "string" ? pattern === file : pattern.test(file)
  const match = patterns(project.testMatch)
  return (
    (match.length === 0 ? file.endsWith(".spec.ts") : match.some(hits)) &&
    !patterns(project.testIgnore).some(hits)
  )
}

// Setup and the kept projects, in config order, each waiting only on kept
// ones. Dropping the rest is what lets a run cover part of the suite:
// Playwright runs every test of a project another one waits on, even with
// --shard, so a project waiting on chromium would bring all of it along.
const keep = <P extends Project>(
  projects: ReadonlyArray<P>,
  kept: (project: P) => boolean
) => {
  const names = new Set(
    projects
      .filter((project) => project.name === SETUP || kept(project))
      .map(({ name }) => name)
  )
  return projects
    .filter(({ name }) => names.has(name))
    .map((project) =>
      project.dependencies === undefined
        ? project
        : {
            ...project,
            dependencies: project.dependencies.filter((name) =>
              names.has(name)
            ),
          }
    )
}

/** Setup and the named projects, for a CI job that runs a part of the suite. */
export function onlyProjects<P extends Project>(
  projects: ReadonlyArray<P>,
  named: ReadonlyArray<string>
) {
  const unknown = named.filter(
    (name) => !projects.some((project) => project.name === name)
  )
  if (unknown.length > 0)
    throw new Error(
      `No e2e project is named ${unknown.join(", ")}. Name projects from playwright.config.ts, comma-separated.`
    )
  return keep(projects, ({ name }) => named.includes(name))
}

/**
 * Setup and the projects that run the picked files, each narrowed to its
 * picked files, for an evidence run's video of them alone.
 */
export function onlyFiles<P extends Project>(
  projects: ReadonlyArray<P>,
  files: ReadonlyArray<string>
) {
  const own = (project: P) => files.filter((file) => runs(project, file))
  return keep(projects, (project) => own(project).length > 0).map((project) =>
    project.name === SETUP ? project : { ...project, testMatch: own(project) }
  )
}
