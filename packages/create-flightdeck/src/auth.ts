import { CliError, type Deps } from "./deps";

/**
 * Credentials for the Access application in front of Flightdeck, in order:
 * an Access service token from the environment, then `cloudflared access token`.
 */
export async function accessHeaders(baseUrl: string, deps: Deps): Promise<Record<string, string>> {
  const id = deps.env.FLIGHTDECK_ACCESS_CLIENT_ID?.trim();
  const secret = deps.env.FLIGHTDECK_ACCESS_CLIENT_SECRET?.trim();
  if (id && secret) return { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret };
  if (id || secret) {
    throw new CliError(
      "Set both FLIGHTDECK_ACCESS_CLIENT_ID and FLIGHTDECK_ACCESS_CLIENT_SECRET, or neither.",
    );
  }
  const token = await deps
    .exec("cloudflared", ["access", "token", "--app", baseUrl])
    .then((out) => out.trim())
    .catch(() => "");
  // cloudflared prints a JWT on success; anything else is an error message.
  if (/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token)) return { "cf-access-token": token };
  throw new CliError(
    [
      `No Cloudflare Access credentials for ${baseUrl}. Either:`,
      "  - set FLIGHTDECK_ACCESS_CLIENT_ID and FLIGHTDECK_ACCESS_CLIENT_SECRET (an Access service token), or",
      `  - install cloudflared and run: cloudflared access login ${baseUrl}`,
    ].join("\n"),
  );
}
