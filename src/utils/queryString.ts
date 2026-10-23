/**
 * Parses a query string value — returns the string if valid,
 * undefined if the key was not present, or an error object if
 * the value was given multiple times (which Express gives as an array).
 */
export function queryString(
  value: unknown,
): string | undefined | { error: string } {
  if (value === undefined) return undefined;
  if (typeof value !== "string")
    return { error: "query parameter must be a single value" };
  return value;
}
