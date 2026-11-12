import { test } from "@playwright/test"

/**
 * The switch an evidence run sets to record video of every test:
 * `E2E_VIDEO=on`. Unset, nothing records.
 */
const SWITCH = "E2E_VIDEO"

const value = process.env[SWITCH]
if (value !== undefined && value !== "" && value !== "on")
  throw new Error(
    `${SWITCH}=${JSON.stringify(value)}: set it to "on" to record video, or unset it.`
  )

// Decision: video records at the viewport's 1280×720, not Playwright's 800×450
// downscale, so a reviewer can read the UI's small text (apinrdw/kumora#210).
const SIZE = { width: 1280, height: 720 }

/** Playwright's `use.video`: every test, at full size, while the switch is on. */
export const video =
  value === "on" ? { mode: "on" as const, size: SIZE } : ("off" as const)

/**
 * The `recordVideo` option for a context a test builds by hand, which
 * `use.video` does not reach: into the running test's results folder while
 * the switch is on, nothing otherwise.
 */
export const recordVideo = () =>
  value === "on"
    ? { recordVideo: { dir: test.info().outputPath(), size: SIZE } }
    : {}
