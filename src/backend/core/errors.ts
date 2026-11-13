/** The error a refusal throws: the routes answer it with its status. */

export class InputError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}
