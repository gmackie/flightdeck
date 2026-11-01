import { parseArgs } from "node:util";
import {
  addApp,
  addKey,
  listApps,
  MAX_KEY_DAYS,
  revokeKey,
  setKeyScopes,
  setLifecycle,
} from "./apps";
import { apiClient, baseUrl } from "./client";
import { CliError, type Deps } from "./deps";

export const HELP = `@flightdeckhq/create (bin: create-flightdeck): set up and use a self-hosted Flightdeck

Usage:
  npx @flightdeckhq/create                         Install Flightdeck (coming in Phase 2)
  npx @flightdeckhq/create apps list [--json]
  npx @flightdeckhq/create apps add <name> [--stage <stage>] [--json]
  npx @flightdeckhq/create apps key <appId> [--days 90] [--out <file>] [--scope <s>]... [--json]
  npx @flightdeckhq/create apps revoke-key <appId> <sha256>
  npx @flightdeckhq/create apps key-scopes <appId> <sha256> --scope <s> [--scope <s>]
  npx @flightdeckhq/create apps grant-lifecycle <appId>
  npx @flightdeckhq/create apps revoke-lifecycle <appId>

Options:
  --url <url>      Flightdeck base URL (default: $FLIGHTDECK_URL)
  --stage <stage>  Deployment stage; omit or use "production" for the production app
  --days <n>       Server key lifetime in days, 1-${MAX_KEY_DAYS} (default 90)
  --out <file>     Write the server key to a new 0600 file instead of stdout
  --scope <s>      Key scope: events.write (default) or lifecycle.write; repeatable.
                   lifecycle.write, key-scopes and *-lifecycle need a LIFECYCLE_ADMINS principal
  --json           Machine-readable output
  -h, --help       Show this help

Auth (Cloudflare Access), first match wins:
  FLIGHTDECK_ACCESS_CLIENT_ID + FLIGHTDECK_ACCESS_CLIENT_SECRET   Access service token
  cloudflared access token --app <url>                             after cloudflared access login
`;

/** Runs the CLI and returns the exit code. */
export async function main(argv: string[], deps: Deps): Promise<number> {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        url: { type: "string" },
        stage: { type: "string" },
        days: { type: "string", default: "90" },
        out: { type: "string" },
        scope: { type: "string", multiple: true },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
    const [group, command, ...rest] = positionals;
    if (values.help || !group) {
      // Phase 2: with no subcommand this becomes the interactive installer.
      deps.stdout(HELP);
      return 0;
    }
    if (group !== "apps") throw new CliError(`Unknown command: ${group}\n\n${HELP}`);
    const request = () => apiClient(baseUrl(values.url, deps), deps);
    const json = values.json;
    if (command === "list" && rest.length === 0) {
      await listApps(await request(), deps, json);
    } else if (command === "add" && rest.length === 1 && rest[0]) {
      await addApp(await request(), deps, { name: rest[0], stage: values.stage, json });
    } else if (command === "key" && rest.length === 1 && rest[0]) {
      const days = Number(values.days);
      await addKey(await request(), deps, {
        appId: rest[0],
        days,
        out: values.out,
        json,
        scopes: values.scope,
      });
    } else if (command === "revoke-key" && rest.length === 2 && rest[0] && rest[1]) {
      await revokeKey(await request(), deps, { appId: rest[0], hash: rest[1] });
    } else if (command === "key-scopes" && rest.length === 2 && rest[0] && rest[1]) {
      const opts = { appId: rest[0], hash: rest[1], scopes: values.scope ?? [] };
      await setKeyScopes(await request(), deps, opts);
    } else if (
      (command === "grant-lifecycle" || command === "revoke-lifecycle") &&
      rest.length === 1 &&
      rest[0]
    ) {
      const grant = command === "grant-lifecycle";
      await setLifecycle(await request(), deps, { appId: rest[0], grant });
    } else {
      throw new CliError(`Usage error.\n\n${HELP}`);
    }
    return 0;
  } catch (error) {
    if (
      error instanceof CliError ||
      (error as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")
    ) {
      deps.stderr(`${(error as Error).message}\n`);
      return 1;
    }
    throw error;
  }
}
