/** The published name, upper-cased, keeping only letters and digits. */
export const holderKey = (name: string): string =>
  name.toUpperCase().replace(/[^\p{L}\p{N}]/gu, "")
