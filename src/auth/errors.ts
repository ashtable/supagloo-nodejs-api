/**
 * Thrown when a request cannot be authenticated (absent / invalid / expired
 * credentials). Routes map it to a `401` response.
 */
export class UnauthorizedError extends Error {
  readonly statusCode = 401;
  constructor(message = "unauthorized") {
    super(message);
    this.name = "UnauthorizedError";
  }
}
