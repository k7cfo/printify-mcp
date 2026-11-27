/** Failures caused by local configuration, before any HTTP call. */
export class PrintifyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrintifyConfigError";
  }
}

/** The caller passed arguments this server will not send to Printify. */
export class PrintifyInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrintifyInputError";
  }
}

/** A Printify HTTP call failed, or the network failed before a response. */
export class PrintifyApiError extends Error {
  readonly status?: number;
  readonly code?: number | string;
  readonly method: string;
  readonly path: string;
  readonly retryable: boolean;

  constructor(
    message: string,
    options: {
      status?: number;
      code?: number | string;
      method: string;
      path: string;
      retryable?: boolean;
    },
  ) {
    super(message);
    this.name = "PrintifyApiError";
    this.status = options.status;
    this.code = options.code;
    this.method = options.method;
    this.path = options.path;
    this.retryable = options.retryable ?? false;
  }
}

/**
 * Replace known secrets and bearer tokens. Secrets shorter than 8 characters
 * are ignored so a tiny test value cannot blank out ordinary words.
 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= 8) {
      out = out.split(secret).join("[redacted]");
    }
  }
  return out.replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
}
