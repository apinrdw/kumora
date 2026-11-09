// The MAIN-world wrapper in the owner's Ajaib tab (spec apinrdw/kumora#138,
// "Broker connections"). Ajaib's REST API answers 403 without the page's exact
// request headers, so this watches the page's own `fetch` and XHR calls to the
// API and hands the latest one's base URL and headers to the isolated content
// script (broker.ts). It changes no request.
//
// It runs at document_start, before the page's scripts, has no chrome.* APIs,
// and stays dependency-free.

// Ajaib's REST routes are versioned: `<base>v1/...`.
const API = "/v1/"

// The latest call's base and headers. The isolated script loads after the
// page's first calls, so it asks for this once it listens.
let latest: { base: string; headers: Record<string, string> } | undefined

const post = () => {
  if (latest !== undefined)
    window.postMessage(
      { kumoraRelay: "page-request", ...latest },
      location.origin
    )
}

window.addEventListener("message", (event) => {
  const data: unknown = event.data
  if (
    event.source === window &&
    typeof data === "object" &&
    data !== null &&
    "kumoraRelay" in data &&
    data.kumoraRelay === "ask-page-request"
  )
    post()
})

const report = (url: string, headers: Headers) => {
  const href = new URL(url, location.href).href
  const at = href.indexOf(API)
  if (at === -1) return
  latest = { base: href.slice(0, at + 1), headers: Object.fromEntries(headers) }
  post()
}

const pageFetch = window.fetch
window.fetch = function (input, init) {
  try {
    const request = input instanceof Request ? input : undefined
    report(
      request?.url ?? String(input),
      new Headers(init?.headers ?? request?.headers)
    )
  } catch {
    // Never break the page's request.
  }
  return pageFetch.call(this, input, init)
}

const opened = new WeakMap<XMLHttpRequest, { url: string; headers: Headers }>()
const pageXhr = XMLHttpRequest.prototype
const { open: pageOpen, setRequestHeader, send } = pageXhr
pageXhr.open = function (
  this: XMLHttpRequest,
  method: string,
  url: string | URL,
  async: boolean = true,
  username?: string | null,
  password?: string | null
) {
  opened.set(this, { url: String(url), headers: new Headers() })
  pageOpen.call(this, method, url, async, username, password)
}
pageXhr.setRequestHeader = function (name, value) {
  try {
    opened.get(this)?.headers.append(name, value)
  } catch {
    // Never break the page's request.
  }
  return setRequestHeader.call(this, name, value)
}
pageXhr.send = function (body) {
  const request = opened.get(this)
  try {
    if (request !== undefined) report(request.url, request.headers)
  } catch {
    // Never break the page's request.
  }
  return send.call(this, body)
}
