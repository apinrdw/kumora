// The workerd package ships no types. Its main module hands the path of the
// installed binary and the newest compatibility date that binary supports
// (tests/server/market-live/workerd.ts runs it).
declare module "workerd" {
  const binary: string
  export default binary
  export const compatibilityDate: string
}
