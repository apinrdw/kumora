declare const publishedSymbolBrand: unique symbol

/**
 * A Symbol exactly as an Ownership file publishes it. Not the domain's `Symbol`, whose four letters
 * would refuse EDJSA. Only ever read back from the store.
 */
export type PublishedSymbol = string & {
  readonly [publishedSymbolBrand]: true
}
