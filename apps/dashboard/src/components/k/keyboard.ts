/** Enter or Space: the keys that activate a native button, for focusable non-button rows. */
export function isActivationKey(key: string): boolean {
  return key === "Enter" || key === " "
}
