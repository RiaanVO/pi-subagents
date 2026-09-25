/** Safely call toLowerCase, treating undefined/null as empty string. */
export function safeLowerCase(s: string | undefined | null): string {
  return s?.toLowerCase() ?? "";
}
