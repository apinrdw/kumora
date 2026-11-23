// How the router writes a page's search params into its URL.
import { stringifySearchWith } from "@tanstack/react-router"

// Decision: a comma-free string list goes in the URL comma-joined, not as JSON
// (apps/dashboard/docs/adr/0031-string-lists-go-in-the-url-comma-joined.md)
const stringifyValue = (value: unknown) =>
  Array.isArray(value) &&
  value.every((each) => typeof each === "string" && !each.includes(","))
    ? value.join(",")
    : JSON.stringify(value)

export const stringifySearch = stringifySearchWith(stringifyValue, JSON.parse)
