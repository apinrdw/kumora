import { describe, expect, it } from "vitest"

import { onlyFiles, onlyProjects } from "./projects"

// The config's shape in small: setup, a chromium project that ignores
// what other projects run, and projects that wait on it.
const PROJECTS = [
  { name: "setup", testMatch: /\.setup\.ts$/ },
  {
    name: "chromium",
    dependencies: ["setup"],
    testIgnore: [/market-live[\w-]*\.spec\.ts$/, /cold-day\.spec\.ts$/],
  },
  {
    name: "trading-day",
    dependencies: ["setup"],
    testMatch: /market-live[\w-]*\.spec\.ts$/,
    workers: 1,
  },
  {
    name: "cold-day",
    dependencies: ["setup", "chromium", "trading-day"],
    testMatch: /cold-day\.spec\.ts$/,
  },
  {
    name: "relay-load",
    dependencies: ["setup", "chromium", "trading-day", "cold-day"],
    testMatch: /relay-load\.spec\.ts$/,
    workers: 1,
  },
]

const names = (projects: ReadonlyArray<{ name: string }>) =>
  projects.map(({ name }) => name)

describe("onlyProjects", () => {
  it("keeps setup and the named projects, waiting only on each other", () => {
    expect(onlyProjects(PROJECTS, ["cold-day"])).toEqual([
      PROJECTS[0],
      { ...PROJECTS[3], dependencies: ["setup"] },
    ])
  })

  it("keeps the order between two named projects", () => {
    const kept = onlyProjects(PROJECTS, ["relay-load", "cold-day"])
    expect(names(kept)).toEqual(["setup", "cold-day", "relay-load"])
    expect(kept.at(-1)?.dependencies).toEqual(["setup", "cold-day"])
  })

  it("refuses a project the config does not have", () => {
    expect(() => onlyProjects(PROJECTS, ["chromium", "firefox"])).toThrow(
      /firefox/
    )
  })
})

describe("onlyFiles", () => {
  it("runs a picked chromium spec alone after setup", () => {
    expect(onlyFiles(PROJECTS, ["account.spec.ts"])).toEqual([
      PROJECTS[0],
      { ...PROJECTS[1], testMatch: ["account.spec.ts"] },
    ])
  })

  it("narrows a project to its picked specs and drops the projects it waited on", () => {
    expect(
      onlyFiles(PROJECTS, ["market-live-select.spec.ts", "cold-day.spec.ts"])
    ).toEqual([
      PROJECTS[0],
      { ...PROJECTS[2], testMatch: ["market-live-select.spec.ts"] },
      {
        ...PROJECTS[3],
        dependencies: ["setup", "trading-day"],
        testMatch: ["cold-day.spec.ts"],
      },
    ])
  })

  it("puts a picked spec in the project that runs it, not one that ignores it", () => {
    expect(names(onlyFiles(PROJECTS, ["cold-day.spec.ts"]))).toEqual([
      "setup",
      "cold-day",
    ])
  })
})
