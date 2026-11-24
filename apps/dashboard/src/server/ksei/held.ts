// What the KSEI archive holds, by filename, from its records' custom
// metadata (../archive/held.ts).
import type { ListedObject } from "../archive/bucket.ts"
import { heldIn, heldRecords } from "../archive/held.ts"
import type { RunId } from "../archive/run.ts"

// The record's custom metadata key a run reads its identity from; the others
// are ../archive/held.ts's. Identity is the filename, not the URL: KSEI moved
// every file to a new path once with the same bytes.
export const FILENAME = "filename"

// The held filenames' records, leaving out those `run` wrote.
export const recordsByFilename = (run?: RunId) => heldRecords(FILENAME, run)

// recordsByFilename from `objects`, a listing of reports/ the step already
// made.
export const recordsIn = (objects: ReadonlyArray<ListedObject>) =>
  heldIn(objects, FILENAME)
