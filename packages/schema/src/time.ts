/** UTC hour bucket used to shard AppDOs, e.g. `2026-10-30T14`. */
export function hourKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 13);
}
