import { ERROR_COPY } from "@/constants/labels";

export type ApiErrorKind = "not_configured" | "offline" | "timeout" | "http" | "parse" | "cancelled";

/**
 * The single error type everything above the API client sees. Screens never
 * inspect fetch errors or status codes directly — they call `describeError`.
 */
export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number | null;
  /** FastAPI's `detail` (or the raw body when it wasn't JSON). */
  readonly detail: string | null;
  readonly path: string | null;

  constructor(kind: ApiErrorKind, message: string, opts: { status?: number; detail?: string; path?: string } = {}) {
    super(message);
    this.name = "ApiError";
    this.kind = kind;
    this.status = opts.status ?? null;
    this.detail = opts.detail ?? null;
    this.path = opts.path ?? null;
  }

  get isNotFound(): boolean {
    return this.kind === "http" && this.status === 404;
  }

  get isConflict(): boolean {
    return this.kind === "http" && this.status === 409;
  }
}

export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError;
}

export interface ErrorDescription {
  title: string;
  message: string;
  /** Whether a "Retry" button makes sense. */
  retryable: boolean;
  /** Technical detail for an "Advanced" disclosure — never the headline. */
  technical: string | null;
}

/** Turns any thrown value into farmer-friendly copy plus an optional technical footnote. */
export function describeError(err: unknown): ErrorDescription {
  if (isApiError(err)) {
    const technical = [err.status ? `HTTP ${err.status}` : null, err.detail, err.path].filter(Boolean).join(" · ") || null;
    switch (err.kind) {
      case "not_configured":
        return { ...ERROR_COPY.notConfigured, retryable: false, technical };
      case "offline":
        return { ...ERROR_COPY.offline, retryable: true, technical };
      case "timeout":
        return { ...ERROR_COPY.timeout, retryable: true, technical };
      case "cancelled":
        return { title: "Cancelled", message: "The request was cancelled.", retryable: true, technical };
      case "parse":
        return {
          title: "Unexpected reply from the server",
          message: "AgroTwin sent a reply this app could not read. Check that the server address points at the AgroTwin API.",
          retryable: true,
          technical,
        };
      case "http":
        if (err.status === 404) return { ...ERROR_COPY.notFound, retryable: false, technical };
        if (err.status === 409)
          return {
            title: "This flight is busy",
            message: err.detail ?? "This survey is being processed — wait for the current job to finish.",
            retryable: true,
            technical,
          };
        if (err.status === 422 || err.status === 400)
          return {
            title: "The server could not accept this",
            message: err.detail ?? ERROR_COPY.generic.message,
            retryable: false,
            technical,
          };
        if (err.status && err.status >= 500)
          return {
            title: "AgroTwin ran into a problem",
            message: err.detail ?? "Something went wrong on the AgroTwin server. Try again in a moment; if it keeps happening, tell the AgroTwin team.",
            retryable: true,
            technical,
          };
        return { ...ERROR_COPY.generic, retryable: true, technical };
    }
  }
  const technical = err instanceof Error ? err.message : err ? String(err) : null;
  return { ...ERROR_COPY.generic, retryable: true, technical };
}
