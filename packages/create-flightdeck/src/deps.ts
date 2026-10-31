/** Everything the CLI touches outside itself, injected so tests never hit the network or disk. */
export type Deps = {
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
  /** Runs a command and resolves its stdout; rejects when it fails or is missing. */
  exec: (command: string, args: string[]) => Promise<string>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Creates `path` exclusively with mode 0600; rejects if it already exists. */
  openSecretFile: (path: string) => Promise<SecretFile>;
  randomBytes: (size: number) => Uint8Array;
  now: () => number;
};

/** An exclusively created secret file; `discard` closes and removes it. */
export type SecretFile = {
  write: (contents: string) => Promise<void>;
  close: () => Promise<void>;
  discard: () => Promise<void>;
};

/** An expected failure: printed as-is, without a stack trace. */
export class CliError extends Error {}
