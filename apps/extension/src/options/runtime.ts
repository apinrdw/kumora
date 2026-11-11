import { Layer, ManagedRuntime } from "effect"

// The options page's runtime. Its Effects read and write chrome.storage and
// need no services, so the layer is empty; every handler runs through it.
export const optionsRuntime = ManagedRuntime.make(Layer.empty)
