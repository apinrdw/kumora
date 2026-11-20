// The MAIN-world wrapper in the owner's Ajaib tab (spec apinrdw/kumora#138,
// "Broker connections"). Ajaib's REST API answers 403 without the page's exact
// request headers, so this watches the page's own `fetch` and XHR calls to the
// API and hands the latest one's base URL and headers to the isolated content
// script (broker.ts). It changes no request.
//
// It also keeps Ajaib's idle PIN lock away and reports it (spec
// apinrdw/kumora#244, "The extension: Ajaib keep-alive and the PIN lock"):
// it moves the mouse and types the PIN when the worker asks, and tells it
// when the lock screen shows or goes and what the page's PIN check answered.
// The worker makes every decision and times every wait.
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

// Ajaib's lock screen: a dialog titled "Masukkan PIN" with six one-digit
// numeric boxes, as seen on 2026-11-13 (apinrdw/kumora#243).
const pinBoxes = () => {
  for (const dialog of document.querySelectorAll('[role="dialog"]')) {
    if (!dialog.textContent?.includes("Masukkan PIN")) continue
    const boxes = dialog.querySelectorAll<HTMLInputElement>(
      'input[inputmode="numeric"][maxlength="1"]'
    )
    if (boxes.length === 6) return boxes
  }
  return undefined
}

let locked = false
const postLock = () =>
  window.postMessage({ kumoraRelay: "lock", locked }, location.origin)
new MutationObserver(() => {
  const now = pinBoxes() !== undefined
  if (now === locked) return
  locked = now
  postLock()
}).observe(document, { childList: true, subtree: true })

// Decision: each box gets its digit through the native value setter and an
// `input` event, so React's own change tracking sees it, as typing would.
const setValue = Object.getOwnPropertyDescriptor(
  HTMLInputElement.prototype,
  "value"
)?.set
const typePin = (pin: string) => {
  const boxes = pinBoxes()
  if (boxes === undefined || setValue === undefined) return false
  boxes.forEach((box, at) => {
    box.focus()
    setValue.call(box, pin[at] ?? "")
    box.dispatchEvent(new Event("input", { bubbles: true }))
  })
  return true
}

window.addEventListener("message", (event) => {
  const data: unknown = event.data
  if (
    event.source !== window ||
    typeof data !== "object" ||
    data === null ||
    !("kumoraRelay" in data)
  )
    return
  switch (data.kumoraRelay) {
    case "ask-page-request":
      return post()
    case "ask-lock":
      return postLock()
    // Re-arms Ajaib's idle lock timer.
    case "activity":
      return void document.dispatchEvent(
        new MouseEvent("mousemove", { bubbles: true })
      )
    case "type-pin":
      if ("pin" in data && typeof data.pin === "string" && "id" in data)
        window.postMessage(
          { kumoraRelay: "pin-typed", id: data.id, typed: typePin(data.pin) },
          location.origin
        )
  }
})

// The page's own PIN check, which unlocks the lock screen: its status.
const PIN_VALIDATE = "/pin/validate"
const postValidated = (status: number) =>
  window.postMessage({ kumoraRelay: "pin-validated", status }, location.origin)

// Decision: only a call that carries `authorization` is kept. A token-less
// call under the API path, such as a `content-type: text/plain` one seen on
// 2026-11-20, otherwise replaced the signed headers the relay sends.
const report = (url: string, headers: Headers) => {
  if (!headers.has("authorization")) return
  const href = new URL(url, location.href).href
  const at = href.indexOf(API)
  if (at === -1) return
  latest = { base: href.slice(0, at + 1), headers: Object.fromEntries(headers) }
  post()
}

const pageFetch = window.fetch
window.fetch = function (input, init) {
  let url = ""
  try {
    const request = input instanceof Request ? input : undefined
    url = request?.url ?? String(input)
    report(url, new Headers(init?.headers ?? request?.headers))
  } catch {
    // Never break the page's request.
  }
  const response = pageFetch.call(this, input, init)
  if (url.includes(PIN_VALIDATE))
    response.then(
      (answered) => postValidated(answered.status),
      () => postValidated(0)
    )
  return response
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
    if (request?.url.includes(PIN_VALIDATE))
      this.addEventListener("loadend", () => postValidated(this.status))
  } catch {
    // Never break the page's request.
  }
  return send.call(this, body)
}
