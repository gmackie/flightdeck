// Fixtures contain JSON-safe aggregates only. Clone each independent input before mutating it.
export function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
export function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("missing test fixture value");
  return value;
}
