/** Domain errors; the API maps them to HTTP status codes. */
export class DomainError extends Error {
  constructor(
    readonly code: "not_found" | "conflict" | "validation_failed" | "forbidden",
    message: string,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export const notFound = (what: string) => new DomainError("not_found", `${what} not found`);
export const conflict = (message: string) => new DomainError("conflict", message);
export const invalid = (message: string) => new DomainError("validation_failed", message);
