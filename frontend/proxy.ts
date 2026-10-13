import { NextResponse, type NextRequest } from "next/server";

/** Sign-in gate in front of the pages and the field data served from public/
 * (map tiles, splats, 3D models). Only an optimistic check — is there a
 * session cookie at all — so a signed-out visitor goes to the sign-in page
 * instead of an empty dashboard; the backend checks the session and what the
 * user may see on every /api request. Keep the name in step with the backend's
 * AGROTWIN_SESSION_COOKIE (default agrotwin_session). */
const SESSION_COOKIE = "agrotwin_session";
const FIELD_DATA = ["/tiles/", "/splats/", "/models/"];

export function proxy(request: NextRequest) {
  if (request.cookies.has(SESSION_COOKIE)) return NextResponse.next();
  const { pathname, search } = request.nextUrl;
  if (FIELD_DATA.some((prefix) => pathname.startsWith(prefix))) {
    return new NextResponse("Please sign in", { status: 401 });
  }
  const login = new URL("/login", request.url);
  if (pathname !== "/") login.searchParams.set("next", pathname + search);
  return NextResponse.redirect(login);
}

export const config = {
  // not: the API (the backend answers 401 itself), the sign-in page, the mobile
  // app's sign-in hand-off, Next's own files, the Cesium library, and top-level
  // static files such as icons
  matcher: ["/((?!api/|login|auth/handoff|_next/|cesium/|favicon\\.ico|[^/]+\\.(?:svg|png|ico|txt|webmanifest)$).*)"],
};
