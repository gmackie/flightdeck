import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import type { LifecycleReadSource } from "../src/source";
import { SyntheticLifecycleSource, type SyntheticOptions } from "../src/sources/synthetic";
import { SYNTHETIC_ANCHOR } from "../src/sources/synthetic-data";
import { type Deps, handleRequest, type WorkerEnv } from "../src/worker";

export const TEAM = "https://acme.cloudflareaccess.com";
export const AUD = "aud-lifecycle-mcp";
/** Five minutes after the synthetic watermark, so synthetic data reads as fresh. */
export const NOW = SYNTHETIC_ANCHOR + 5 * 60_000;
export const now = () => NOW;
export const MCP_URL = "https://lifecycle-mcp.test/mcp";
export const PROTOCOL = "2026-07-28";

const pair = await generateKeyPair("RS256");
export const keys = createLocalJWKSet({
  keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256" }],
});

/** A staging Worker serving synthetic data behind Access: the configuration tests start from. */
export const ENV: WorkerEnv = {
  LIFECYCLE_MCP_ENVIRONMENT: "staging",
  LIFECYCLE_MCP_SOURCE: "synthetic",
  ACCESS_TEAM_DOMAIN: TEAM,
  ACCESS_AUD: AUD,
  LIFECYCLE_MCP_MIN_COHORT: "5",
  LIFECYCLE_MCP_ALLOWED_ORIGINS: "",
  LIFECYCLE_MCP_DEV: "0",
  LIFECYCLE_MCP_RESOURCE: MCP_URL,
};

type SignOpts = {
  sub?: string;
  aud?: string | string[];
  iss?: string;
  exp?: number | string;
  kid?: string;
};

export function sign(claims: Record<string, unknown>, opts: SignOpts = {}) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: opts.kid ?? "k1" })
    .setSubject(opts.sub ?? "user-uuid-1")
    .setIssuer(opts.iss ?? TEAM)
    .setAudience(opts.aud ?? AUD)
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? "5m")
    .sign(pair.privateKey);
}

export const userToken = () => sign({ email: "analyst@example.com" });
export const serviceToken = () => sign({ common_name: "agent.access" }, { sub: "" });

export const synthetic = (opts: SyntheticOptions = {}) =>
  new SyntheticLifecycleSource({ now, ...opts });

export type Setup = {
  token?: string | null;
  env?: WorkerEnv;
  source?: LifecycleReadSource;
  /** The handler clock; the default source clock is unchanged, so pass a matching source. */
  now?: () => number;
};

/** Calls the Worker handler directly, as the runtime would. */
export function serve(request: Request, setup: Setup = {}): Promise<Response> {
  const deps: Deps = { keys, now: setup.now ?? now, source: setup.source ?? synthetic() };
  return handleRequest(request, setup.env ?? ENV, deps);
}

/** A real MCP client pinned to the 2026-07-28 protocol, talking to the handler in-process. */
export async function connect(setup: Setup = {}): Promise<Client> {
  const token = setup.token === undefined ? await userToken() : setup.token;
  const client = new Client(
    { name: "lifecycle-mcp-test", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: PROTOCOL } } },
  );
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: { headers: token ? { "Cf-Access-Jwt-Assertion": token } : {} },
    fetch: (url, init) => serve(new Request(url, init), setup),
  });
  await client.connect(transport);
  return client;
}

export type ToolOutcome = {
  isError: boolean;
  // biome-ignore lint/suspicious/noExplicitAny: test access to arbitrary result shapes.
  data: any;
  error: { code: string; message: string } | null;
  text: string;
};

export async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolOutcome> {
  const result = await client.callTool({ name, arguments: args });
  const content = (result.content ?? []) as { type: string; text?: string }[];
  const text = content.map((block) => block.text ?? "").join("");
  if (result.isError) {
    let error = { code: "input_validation", message: text };
    try {
      error = JSON.parse(text).error ?? error;
    } catch {}
    return { isError: true, data: null, error, text };
  }
  return { isError: false, data: result.structuredContent, error: null, text };
}

const ENVELOPE_META = {
  "io.modelcontextprotocol/protocolVersion": PROTOCOL,
  "io.modelcontextprotocol/clientInfo": { name: "raw", version: "1" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

/** A hand-built 2026-07-28 request, for methods the SDK client refuses to send. */
export async function raw(
  method: string,
  params: Record<string, unknown> = {},
  setup: Setup & { headers?: Record<string, string> } = {},
) {
  const token = setup.token === undefined ? await userToken() : setup.token;
  const request = new Request(MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "Mcp-Protocol-Version": PROTOCOL,
      "Mcp-Method": method,
      ...(token ? { "Cf-Access-Jwt-Assertion": token } : {}),
      ...setup.headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: { ...params, _meta: ENVELOPE_META },
    }),
  });
  const response = await serve(request, setup);
  const text = await response.text();
  let body: { error?: { code: number; message: string }; result?: unknown } | null = null;
  try {
    body = JSON.parse(text);
  } catch {}
  return { status: response.status, body, text, headers: response.headers };
}

export const RELEASE = "synthetic-release";
export const SUPPORT = "synthetic-support";
export const RESTRICTED = "synthetic-restricted";
