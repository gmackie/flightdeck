export type UserAgentInfo = {
  device: "mobile" | "tablet" | "desktop" | "bot" | "unknown";
  browser: string;
  os: string;
};

/** Coarse device, browser, and OS families. Deliberately small; no full UA database. */
export function parseUserAgent(ua: string | undefined): UserAgentInfo {
  if (!ua) return { device: "unknown", browser: "Other", os: "Other" };
  const bot =
    /bot\b|bot\/|crawl|spider|slurp|headless|lighthouse|curl\/|wget\/|python-requests|okhttp|node-fetch|go-http-client/i.test(
      ua,
    ) && !/cubot/i.test(ua);
  const tablet = /iPad|Tablet/i.test(ua) || (/Android/.test(ua) && !/Mobile/.test(ua));
  const mobile = !tablet && /Mobi|iPhone|iPod|Android/.test(ua);
  const browser = /Edg(e|A|iOS)?\//.test(ua)
    ? "Edge"
    : /OPR\/|Opera/.test(ua)
      ? "Opera"
      : /Firefox\/|FxiOS/.test(ua)
        ? "Firefox"
        : /Chrome\/|CriOS/.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : "Other";
  const os = /iPhone|iPad|iPod/.test(ua)
    ? "iOS"
    : /Android/.test(ua)
      ? "Android"
      : /CrOS/.test(ua)
        ? "ChromeOS"
        : /Mac OS X|Macintosh/.test(ua)
          ? "macOS"
          : /Windows/.test(ua)
            ? "Windows"
            : /Linux/.test(ua)
              ? "Linux"
              : "Other";
  return { device: bot ? "bot" : tablet ? "tablet" : mobile ? "mobile" : "desktop", browser, os };
}
