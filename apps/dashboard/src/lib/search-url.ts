// How the router writes a page's search params into its URL.
import { stringifySearchWith } from "@tanstack/react-router"

// Decision: a list of strings with no commas is written comma-joined, so the
// stock page's chips read `brokers=buy,sell,YP` as spec apinrdw/kumora#437
// names it, not the router's JSON `["buy","sell","YP"]`. It reads back as
// one string, which the page's validateSearch splits into its typed list.
// Any other object is JSON, as the router writes it by default.
const stringifyValue = (value: unknown) =>
  Array.isArray(value) &&
  value.every((each) => typeof each === "string" && !each.includes(","))
    ? value.join(",")
    : JSON.stringify(value)

export const stringifySearch = stringifySearchWith(stringifyValue, JSON.parse)
