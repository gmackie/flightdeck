const ID_SEGMENT = [
  /^\d+$/,
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  /^[0-9A-HJKMNP-TV-Z]{26}$/i,
  /^[0-9a-f]{16,}$/i,
];

/** Collapses ids in a path so `/users/123` and `/users/456` become one journey step. */
export function normalizeRoute(path: string): string {
  const pathname = path.split(/[?#]/, 1)[0] || "/";
  const out = pathname
    .split("/")
    .map((seg) => (seg && ID_SEGMENT.some((re) => re.test(seg)) ? ":id" : seg))
    .join("/");
  return out.length > 1 && out.endsWith("/") ? out.slice(0, -1) : out || "/";
}
