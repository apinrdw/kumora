// The archive run's classification months to parse (../holdings/
// parse-steps.ts): a data date is parsed when its newest archived version
// (by fetched-at) or the parser's version differs from the version its
// parsed holdings came from, or when it has none. Spec apinrdw/kumora#363,
// "IDX archive run: the reconcile step".
import {
  PARSER_VERSION,
  parseClassificationMonth,
  parsedClassificationMonths,
} from "../holdings/classification.ts"
import type { MonthSource } from "../holdings/parse-steps.ts"
import { kindPrefix, reportKey } from "./keys.ts"

const KIND = "investor-classification"

export const classificationMonths: MonthSource = {
  prefix: kindPrefix(KIND),
  reportKey: (dataDate, sha256) => reportKey(KIND, dataDate, sha256),
  parsed: parsedClassificationMonths,
  parserVersion: PARSER_VERSION,
  parse: parseClassificationMonth,
}
