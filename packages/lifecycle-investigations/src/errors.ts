export type InvestigationErrorCode =
  | "forbidden"
  | "invalid_request"
  | "invalid_catalog"
  | "unsupported_recipe"
  | "not_comparable"
  | "invalid_window"
  | "unregistered"
  | "budget_exceeded"
  | "invalid_options";

/** Fixed, caller-safe messages. Never includes input values, adapter errors or identifiers. */
export class InvestigationError extends Error {
  constructor(
    readonly code: InvestigationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "InvestigationError";
  }
}

export function check(
  condition: unknown,
  code: InvestigationErrorCode,
  message: string,
): asserts condition {
  if (!condition) throw new InvestigationError(code, message);
}
