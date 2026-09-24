export const THINKING_WORDS = [
  'Pondering',
  'Crunching numbers',
  'Scanning forecasts',
  'Checking alerts',
  'Connecting the dots',
  'Weighing scenarios',
  'Reading the data',
  'Tracing price moves',
  'Cross-checking',
  'Digging in',
] as const;

/** Random loader word that never repeats the previous one back to back. */
export function pickThinkingWord(previous: string | null, random: () => number = Math.random): string {
  const pool = THINKING_WORDS.filter((word) => word !== previous);
  return pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))];
}
