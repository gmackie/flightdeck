const SESSION_KEY = "fd_sid";
const LAST_KEY = "fd_last";
const ANON_KEY = "fd_aid";
export const SESSION_IDLE_MS = 30 * 60_000;

const memory = new Map<string, string>();
let ephemeralAnon: string | undefined;

/** 32 hex chars. `randomUUID` is missing outside secure contexts (e.g. http on a LAN). */
export function randomId(): string {
  const c = globalThis.crypto;
  if (c.randomUUID) return c.randomUUID().replaceAll("-", "");
  return Array.from(c.getRandomValues(new Uint8Array(16)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

function read(store: () => Storage, key: string): string | null {
  try {
    return store().getItem(key);
  } catch {
    return memory.get(key) ?? null;
  }
}

function write(store: () => Storage, key: string, value: string): void {
  try {
    store().setItem(key, value);
  } catch {
    memory.set(key, value);
  }
}

/** Session id in sessionStorage, rotated after 30 minutes without activity. */
export function sessionId(now = Date.now()): string {
  const session = () => sessionStorage;
  let id = read(session, SESSION_KEY);
  if (!id || now - Number(read(session, LAST_KEY) ?? 0) > SESSION_IDLE_MS) {
    id = randomId();
    write(session, SESSION_KEY, id);
  }
  write(session, LAST_KEY, String(now));
  return id;
}

/** Persistent anonymous id in localStorage, or a page-lifetime id when persistence is off. */
export function anonymousId(persist: boolean): string {
  if (!persist) {
    ephemeralAnon ??= randomId();
    return ephemeralAnon;
  }
  const local = () => localStorage;
  let id = read(local, ANON_KEY);
  if (!id) {
    id = randomId();
    write(local, ANON_KEY, id);
  }
  return id;
}
