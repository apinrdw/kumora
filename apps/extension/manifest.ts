// The relay extension's manifest, written to dist/manifest.json by the
// manifest plugin in vite.config.ts. The entries below are also the build's
// inputs, so a file named here is always one the build emits.

// Each script entry: the source the build reads, and the file the manifest
// names in dist.
export const scriptEntries = {
  "service-worker": "src/worker/service-worker.ts",
  broker: "src/content/broker.ts",
  page: "src/content/page.ts",
} as const

export const optionsPage = "options.html"

// The broker tabs the relay reads. Exact hosts only.
const AJAIB_TAB = "https://trade.ajaib.co.id/*"
const STOCKBIT_TAB = "https://stockbit.com/*"

export const manifest = (
  productionDashboard: string
): chrome.runtime.ManifestV3 => ({
  manifest_version: 3,
  name: "Kumora relay",
  version: "0.0.1",
  description:
    "Relays Stockbit's and Ajaib's live data from signed-in tabs to Kumora's Market Live.",
  // Port messages keep the service worker alive from 110, websocket traffic
  // from 116. Manifest-declared MAIN-world scripts need 111.
  minimum_chrome_version: "116",
  permissions: ["storage", "alarms"],
  // Decision: exact hosts only, never a `*.workers.dev` wildcard: workers.dev
  // is on the Public Suffix List, so one would admit any Workers site. The
  // extra target's ingest socket needs no host permission. See
  // apinrdw/kumora#135.
  host_permissions: [`${productionDashboard}/*`, STOCKBIT_TAB, AJAIB_TAB],
  background: {
    service_worker: `${"service-worker" satisfies keyof typeof scriptEntries}.js`,
    type: "module",
  },
  content_scripts: [
    {
      matches: [STOCKBIT_TAB, AJAIB_TAB],
      js: [`${"broker" satisfies keyof typeof scriptEntries}.js`],
      run_at: "document_idle",
    },
    // Watches the Ajaib page's own REST requests for their headers. It must
    // run before the page's scripts to see their first calls.
    {
      matches: [AJAIB_TAB],
      js: [`${"page" satisfies keyof typeof scriptEntries}.js`],
      run_at: "document_start",
      world: "MAIN",
    },
  ],
  options_ui: { page: optionsPage, open_in_tab: true },
  action: { default_title: "Kumora relay" },
})
