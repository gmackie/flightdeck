/** Everything the CLI touches outside itself, injected so tests never hit the network or disk. */
export type Deps = {
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
  /** Runs a command and resolves its stdout; rejects when it fails or is missing. */
  exec: (command: string, args: string[]) => Promise<string>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Creates `path` with mode 0600 and fails if it already exists. */
  writeSecretFile: (path: string, contents: string) => Promise<void>;
  randomBytes: (size: number) => Uint8Array;
  now: () => number;
};

/** An expected failure: printed as-is, without a stack trace. */
export class CliError extends Error {}
