import type { ClientEventInput } from "@flightdeckhq/schema";

const MAX_BATCH = 50;
/** The endpoint rejects bodies over 64 KiB; leave headroom. */
export const MAX_BODY_BYTES = 60 * 1024;

export type Transport = (endpoint: string, body: string) => void;

const encoder = new TextEncoder();
const byteLength = (s: string) => encoder.encode(s).length;

/** Beacon first; a string body makes fetch send `text/plain`, which the endpoint accepts. */
export function sendBatch(endpoint: string, body: string): void {
  if (navigator.sendBeacon?.(endpoint, new Blob([body], { type: "text/plain" }))) return;
  fetch(endpoint, { method: "POST", body, keepalive: true }).catch(() => {});
}

export class EventQueue {
  private events: ClientEventInput[] = [];

  constructor(
    private readonly opts: { endpoint: string; maxBatch: number },
    private readonly transport: Transport = sendBatch,
  ) {}

  push(event: ClientEventInput): void {
    this.events.push(event);
    if (this.events.length >= this.opts.maxBatch) this.flush();
  }

  /** Sends everything queued, split into bodies of at most 50 events and MAX_BODY_BYTES. */
  flush(): void {
    const events = this.events;
    this.events = [];
    let batch: string[] = [];
    // `{"events":[` + `]}`
    let size = 13;
    const send = () => {
      if (batch.length) this.transport(this.opts.endpoint, `{"events":[${batch.join(",")}]}`);
      batch = [];
      size = 13;
    };
    for (const event of events) {
      const json = JSON.stringify(event);
      const bytes = byteLength(json) + 1;
      if (batch.length >= MAX_BATCH || size + bytes > MAX_BODY_BYTES) send();
      batch.push(json);
      size += bytes;
    }
    send();
  }
}
