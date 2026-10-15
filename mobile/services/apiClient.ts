import { requestTimeoutMs, uploadTimeoutMs } from "@/constants/config";
import { ApiError } from "./errors";
import { CONSENT_REQUIRED, getApiUrl, getAuthToken, getWebViewerUrl, notifyConsentRequired, notifyUnauthorized } from "./runtimeConfig";

/**
 * Centralised HTTP access to the FastAPI backend. Every service goes through
 * `request` / `uploadMultipart`; screens and components never call fetch.
 *
 * Responsibilities: base URL, headers (incl. future Authorization), JSON
 * parsing, timeouts, and normalising failures into ApiError.
 */

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Serialised as JSON unless it is already a FormData/string. */
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Query string parameters; null/undefined values are dropped. */
  query?: Record<string, string | number | boolean | null | undefined>;
}

function requireBase(kind: "api" | "web"): string {
  const base = kind === "api" ? getApiUrl() : getWebViewerUrl();
  if (!base) throw new ApiError("not_configured", "Server address not configured");
  return base;
}

function withQuery(path: string, query?: RequestOptions["query"]): string {
  if (!query) return path;
  const params = Object.entries(query)
    .filter(([, v]) => v != null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  if (params.length === 0) return path;
  return `${path}${path.includes("?") ? "&" : "?"}${params.join("&")}`;
}

/** Absolute URL on the FastAPI server for a backend path such as `/api/surveys/x/images/y/thumbnail`. */
export function apiUrl(path: string): string {
  return `${requireBase("api")}${path.startsWith("/") ? path : `/${path}`}`;
}

/** Absolute URL on the Next.js web app (Cesium viewer, static tile pyramids under /tiles). */
export function webUrl(path: string): string {
  return `${requireBase("web")}${path.startsWith("/") ? path : `/${path}`}`;
}

/**
 * Resolves an asset's `public_url`: `/api/...` paths live on FastAPI, everything
 * else (`/tiles`, `/models`, `/splats`) is a static file on the web app.
 */
export function publicAssetUrl(publicUrl: string): string {
  return publicUrl.startsWith("/api/") ? apiUrl(publicUrl) : webUrl(publicUrl);
}

export function authHeaders(): Record<string, string> {
  const token = getAuthToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function linkSignals(timeoutMs: number, external?: AbortSignal): { signal: AbortSignal; clear: () => void; timedOut: () => boolean } {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onExternalAbort = () => controller.abort();
  external?.addEventListener("abort", onExternalAbort);
  return {
    signal: controller.signal,
    clear: () => {
      clearTimeout(timer);
      external?.removeEventListener("abort", onExternalAbort);
    },
    timedOut: () => timedOut,
  };
}

async function readDetail(res: Response): Promise<string | null> {
  try {
    const text = await res.text();
    if (!text) return null;
    try {
      const body = JSON.parse(text) as { detail?: unknown };
      if (body && typeof body === "object" && "detail" in body) {
        return typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
      }
      return text.slice(0, 300);
    } catch {
      return text.slice(0, 300);
    }
  } catch {
    return null;
  }
}

function networkError(err: unknown, path: string): ApiError {
  const message = err instanceof Error ? err.message : String(err);
  return new ApiError("offline", message || "Network request failed", { path });
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const url = withQuery(apiUrl(path), options.query);
  const isForm = typeof FormData !== "undefined" && options.body instanceof FormData;
  const headers: Record<string, string> = { Accept: "application/json", ...authHeaders(), ...options.headers };
  let body: BodyInit | undefined;
  if (options.body !== undefined) {
    if (isForm || typeof options.body === "string") {
      body = options.body as BodyInit;
    } else {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.body);
    }
  }

  const { signal, clear, timedOut } = linkSignals(options.timeoutMs ?? requestTimeoutMs, options.signal);
  let res: Response;
  try {
    res = await fetch(url, { method: options.method ?? "GET", headers, body, signal });
  } catch (err) {
    clear();
    if (timedOut()) throw new ApiError("timeout", "Request timed out", { path });
    if (options.signal?.aborted) throw new ApiError("cancelled", "Request cancelled", { path });
    throw networkError(err, path);
  }
  clear();

  if (res.status === 401 && headers.Authorization) notifyUnauthorized();
  if (!res.ok) {
    const detail = await readDetail(res);
    if (res.status === 403 && detail?.startsWith(CONSENT_REQUIRED)) notifyConsentRequired();
    throw new ApiError("http", detail ?? res.statusText ?? `Request failed (${res.status})`, {
      status: res.status,
      detail: detail ?? undefined,
      path,
    });
  }
  if (res.status === 204) return undefined as T;

  const text = await res.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError("parse", "Response was not valid JSON", { status: res.status, path, detail: text.slice(0, 120) });
  }
}

export function getJson<T>(path: string, options: Omit<RequestOptions, "method" | "body"> = {}): Promise<T> {
  return request<T>(path, { ...options, method: "GET" });
}

export function postJson<T>(path: string, body?: unknown, options: Omit<RequestOptions, "method" | "body"> = {}): Promise<T> {
  return request<T>(path, { ...options, method: "POST", body });
}

export function del<T>(path: string, options: Omit<RequestOptions, "method" | "body"> = {}): Promise<T> {
  return request<T>(path, { ...options, method: "DELETE" });
}

export interface UploadOptions {
  onProgress?: (fraction: number) => void;
  timeoutMs?: number;
  signal?: AbortSignal;
  query?: RequestOptions["query"];
}

/**
 * Multipart upload with progress. Uses XMLHttpRequest because React Native's
 * fetch has no upload-progress events.
 */
export function uploadMultipart<T>(path: string, form: FormData, options: UploadOptions = {}): Promise<T> {
  const url = withQuery(apiUrl(path), options.query);
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.timeout = options.timeoutMs ?? uploadTimeoutMs;
    xhr.setRequestHeader("Accept", "application/json");
    for (const [k, v] of Object.entries(authHeaders())) xhr.setRequestHeader(k, v);

    const abort = () => xhr.abort();
    options.signal?.addEventListener("abort", abort);
    const cleanup = () => options.signal?.removeEventListener("abort", abort);

    xhr.upload.onprogress = (evt) => {
      if (evt.lengthComputable && options.onProgress) options.onProgress(evt.loaded / evt.total);
    };
    xhr.onload = () => {
      cleanup();
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(xhr.responseText ? (JSON.parse(xhr.responseText) as T) : (undefined as T));
        } catch {
          reject(new ApiError("parse", "Response was not valid JSON", { status: xhr.status, path }));
        }
        return;
      }
      if (xhr.status === 401 && authHeaders().Authorization) notifyUnauthorized();
      let detail: string | null = null;
      try {
        const body = JSON.parse(xhr.responseText) as { detail?: unknown };
        detail = typeof body.detail === "string" ? body.detail : body.detail ? JSON.stringify(body.detail) : null;
      } catch {
        detail = xhr.responseText?.slice(0, 300) || null;
      }
      if (xhr.status === 403 && detail?.startsWith(CONSENT_REQUIRED)) notifyConsentRequired();
      reject(new ApiError("http", detail ?? `Upload failed (${xhr.status})`, { status: xhr.status, detail: detail ?? undefined, path }));
    };
    xhr.onerror = () => {
      cleanup();
      reject(new ApiError("offline", "Network request failed", { path }));
    };
    xhr.ontimeout = () => {
      cleanup();
      reject(new ApiError("timeout", "Upload timed out", { path }));
    };
    xhr.onabort = () => {
      cleanup();
      reject(new ApiError("cancelled", "Upload cancelled", { path }));
    };
    xhr.send(form);
  });
}
