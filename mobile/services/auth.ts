import type { User } from "@/types";
import { getJson, postJson } from "./apiClient";
import { getWebViewerUrl } from "./runtimeConfig";

/** POST/GET /api/auth/* — the same sign-in the web app uses (backend/app/routers/auth.py).
 * The token is sent as `Authorization: Bearer …` by the API client. */
export const authService = {
  login: (email: string, password: string) => postJson<{ user: User; token: string }>("/api/auth/login", { email, password }),
  logout: () => postJson<{ signed_out: boolean }>("/api/auth/logout", {}),
  me: () => getJson<User>("/api/auth/me"),
  /** A one-time code (valid a minute) that signs the embedded web viewer in. */
  handoff: () => postJson<{ code: string }>("/api/auth/handoff", {}),
};

/** The viewer URL, wrapped in the web app's hand-off: the WebView keeps its own
 * cookies, so it exchanges a one-time code for its own session, then opens
 * `viewerUrl`. Without a signed-in app the plain URL. */
export async function signedViewerUrl(viewerUrl: string, signedIn: boolean): Promise<string> {
  if (!signedIn) return viewerUrl;
  const { code } = await authService.handoff();
  const base = getWebViewerUrl().replace(/\/+$/, "");
  const next = viewerUrl.startsWith(base) ? viewerUrl.slice(base.length) || "/" : viewerUrl;
  return `${base}/auth/handoff?${new URLSearchParams({ code, next }).toString()}`;
}
