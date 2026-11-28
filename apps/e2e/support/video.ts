import { test } from "@playwright/test"

/**
 * The switch an evidence run sets to run and record video of only the specs
 * it will post: `E2E_VIDEO=<spec>,<spec>`, each a spec file under tests/ by
 * name or by a path ending in it. Unset or empty, the whole suite runs and
 * nothing records. scripts/e2e-evidence.mts sets it by name, so change the
 * two together.
 */
export const SWITCH = "E2E_VIDEO"

/** The specs the config's trading-day project runs. */
export const TRADING_DAY_SPECS = /market-live[\w-]*\.spec\.ts$/

/** The spec the config's cold-day project runs. */
export const COLD_DAY_SPEC = /cold-day\.spec\.ts$/

/** The spec the config's holder-moves project runs. */
export const HOLDER_MOVES_SPEC = /holder-moves\.spec\.ts$/

/** The spec the config's holder-map project runs. */
export const HOLDER_MAP_SPEC = /holder-map\.spec\.ts$/

/** The spec the config's relay-load project runs. */
export const RELAY_LOAD_SPEC = /relay-load\.spec\.ts$/

/** The spec the config's repaint-bench project runs. */
export const REPAINT_BENCH_SPEC = /repaint-bench\.spec\.ts$/

// The specs that time the CPU, so never record: encoding video would take
// the CPU they measure.
const TIMED_SPECS = [RELAY_LOAD_SPEC, REPAINT_BENCH_SPEC]

// A spec as typed names a file under tests/ by its name or a path ending in
// it: the rule filesOf in scripts/e2e-evidence-plan.mts applies to the specs
// it sends here, so change the two together.
const isNamedBy = (typed: string) => (file: string) =>
  file === typed || typed.endsWith(`/${file}`)

/**
 * The spec files under tests/ the switch's value picks, by file name. An
 * evidence run runs these alone (support/projects.ts's onlyFiles).
 */
export function pickedFiles(
  value: string | undefined,
  files: ReadonlyArray<string>
) {
  const specs = files.filter((file) => file.endsWith(".spec.ts"))
  const typed = value ? value.split(",") : []
  const unknown = typed.filter((spec) => !specs.some(isNamedBy(spec)))
  if (unknown.length > 0)
    throw new Error(
      `${SWITCH}=${JSON.stringify(value)}: no spec file under apps/e2e/tests is ${unknown.join(", ")}. Set it to the spec files to record, comma-separated, or unset it.`
    )
  return specs.filter((file) => typed.some((spec) => isNamedBy(spec)(file)))
}

/**
 * What records, from the switch's value and the files under tests/: the
 * picked chromium specs, and whether the trading-day, cold-day,
 * holder-moves and holder-map projects record.
 */
export function recording(
  value: string | undefined,
  files: ReadonlyArray<string>
) {
  const picked = pickedFiles(value, files)
  return {
    // A picked relay-load spec or repaint bench records nothing,
    // since encoding video would take CPU from the relay whose lag, or the
    // charts whose repaint, it measures.
    chromium: picked.filter(
      (file) =>
        !TRADING_DAY_SPECS.test(file) &&
        !COLD_DAY_SPEC.test(file) &&
        !HOLDER_MOVES_SPEC.test(file) &&
        !HOLDER_MAP_SPEC.test(file) &&
        !TIMED_SPECS.some((spec) => spec.test(file))
    ),
    tradingDay: picked.some((file) => TRADING_DAY_SPECS.test(file)),
    coldDay: picked.some((file) => COLD_DAY_SPEC.test(file)),
    holderMoves: picked.some((file) => HOLDER_MOVES_SPEC.test(file)),
    holderMap: picked.some((file) => HOLDER_MAP_SPEC.test(file)),
  }
}

// Video records at the viewport's 1280×720, not Playwright's 800×450
// downscale, so a reviewer can read the UI's small text (apinrdw/kumora#210).
const SIZE = { width: 1280, height: 720 }

/** Playwright's `use.video` for a project that records: every test, at full size. */
export const video = { mode: "on" as const, size: SIZE }

/**
 * The `recordVideo` option for a context a test builds by hand, which
 * `use.video` does not reach: into the running test's results folder while
 * its project records, nothing otherwise.
 */
export const recordVideo = () => {
  const mode = test.info().project.use.video
  return mode === undefined || mode === "off"
    ? {}
    : { recordVideo: { dir: test.info().outputPath(), size: SIZE } }
}
