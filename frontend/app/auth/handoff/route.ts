import { NextResponse, type NextRequest } from "next/server";

/** The mobile app opens the web viewer here with a one-time code from
 * POST /api/auth/handoff: the code becomes this WebView's own sign-in cookie,
 * then the viewer page opens (`next`). A WebView keeps its own cookies, so the
 * app's token cannot be used there directly. */
const API = process.env.AGROTWIN_API_URL ?? "http://127.0.0.1:8000";
const SESSION_COOKIE = "agrotwin_session"; // as in proxy.ts and the backend

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code") ?? "";
  const nextParam = request.nextUrl.searchParams.get("next") ?? "/dashboard";
  const next = nextParam.startsWith("/") && !nextParam.startsWith("//") ? nextParam : "/dashboard";
  // behind nginx the request reaches us as plain http on 127.0.0.1: rebuild the public address
  const proto = request.headers.get("x-forwarded-proto") ?? request.nextUrl.protocol.replace(":", "");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? request.nextUrl.host;
  const base = `${proto}://${host}`;

  const res = await fetch(`${API}/api/auth/handoff/redeem`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
    cache: "no-store",
  }).catch(() => null);
  if (!res?.ok) return NextResponse.redirect(new URL(`/login?next=${encodeURIComponent(next)}`, base));

  const { token } = (await res.json()) as { token: string };
  const out = NextResponse.redirect(new URL(next, base));
  out.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: proto === "https",
    path: "/",
    maxAge: 60 * 24 * 3600,
  });
  return out;
}
