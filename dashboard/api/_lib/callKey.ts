/** A stable key for deduping identical tool calls: same params, in any key order. */
export function callKey(args: Record<string, unknown>): string {
  const sorted = Object.keys(args)
    .sort()
    .reduce<Record<string, unknown>>((acc, k) => {
      if (args[k] !== undefined) acc[k] = args[k];
      return acc;
    }, {});
  return JSON.stringify(sorted);
}
