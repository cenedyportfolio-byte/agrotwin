import { env, normalizeBaseUrl } from "@/constants/config";

/**
 * Mutable runtime configuration for the API client. The settings store
 * pushes user overrides here so the client itself has no dependency on
 * Zustand or SecureStore (and so tests can configure it directly).
 */
interface RuntimeConfig {
  apiUrl: string;
  webViewerUrl: string;
  /** The signed-in session's bearer token; null when signed out. */
  getAuthToken: () => string | null;
  /** Called when the server answers 401 to a signed-in request (session ended). */
  onUnauthorized: () => void;
  /** Called when the server asks for the data agreement to be accepted first. */
  onConsentRequired: () => void;
}

const config: RuntimeConfig = {
  apiUrl: normalizeBaseUrl(env.apiUrl),
  webViewerUrl: normalizeBaseUrl(env.webViewerUrl),
  getAuthToken: () => null,
  onUnauthorized: () => {},
  onConsentRequired: () => {},
};

export function setBaseUrls(urls: { apiUrl?: string | null; webViewerUrl?: string | null }): void {
  config.apiUrl = normalizeBaseUrl(urls.apiUrl?.trim() || env.apiUrl);
  config.webViewerUrl = normalizeBaseUrl(urls.webViewerUrl?.trim() || env.webViewerUrl);
}

export function setAuthTokenGetter(getter: () => string | null): void {
  config.getAuthToken = getter;
}

export function setUnauthorizedHandler(handler: () => void): void {
  config.onUnauthorized = handler;
}

/** A signed-in request was refused: the session expired or the account was switched off. */
export function notifyUnauthorized(): void {
  config.onUnauthorized();
}

export function setConsentRequiredHandler(handler: () => void): void {
  config.onConsentRequired = handler;
}

/** The backend's answer to a farmer who has not accepted the data agreement (auth.CONSENT_REQUIRED). */
export const CONSENT_REQUIRED = "Accept the data agreement";

/** A request was refused until the data agreement (or its new version) is accepted. */
export function notifyConsentRequired(): void {
  config.onConsentRequired();
}

export function getApiUrl(): string {
  return config.apiUrl;
}

export function getWebViewerUrl(): string {
  return config.webViewerUrl;
}

export function getAuthToken(): string | null {
  return config.getAuthToken();
}
