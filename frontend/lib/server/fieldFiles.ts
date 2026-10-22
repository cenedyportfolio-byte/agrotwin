import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import type { NextRequest } from "next/server";

/**
 * Field data written to public/ after the website was built — the map tiles,
 * 3D models and splats of a flight processed since. `next start` serves only
 * the public files that existed at build time (Next checks them before any
 * route), so without this a new flight's map tiles answered 404 and the
 * viewer fell back to the blurry flat preview until the next build.
 *
 * Each file is served once the backend agrees this user may see that flight —
 * the same question nginx asks it on the university server (GET
 * /api/auth/file-access), remembered for a minute per sign-in and flight.
 */

// turbopackIgnore: the build traces fs paths it can work out, and this one
// would make it list every tile under public/ — minutes on the exFAT drive
const PUBLIC = path.join(/* turbopackIgnore: true */ process.cwd(), "public");
const API = process.env.AGROTWIN_API_URL ?? "http://127.0.0.1:8000";
const SESSION_COOKIE = "agrotwin_session"; // as in proxy.ts
const ALLOW_MS = 60_000;
const allowed = new Map<string, number>();

const TYPES: Record<string, string> = {
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".json": "application/json",
  ".geojson": "application/geo+json",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".ktx2": "image/ktx2",
};

export type FieldFolder = "tiles" | "models" | "splats";

async function mayRead(request: NextRequest, folder: FieldFolder, parts: string[]): Promise<number> {
  const who = request.cookies.get(SESSION_COOKIE)?.value ?? request.headers.get("authorization") ?? "";
  if (!who) return 401;
  const key = `${who}|${folder}/${parts[0]}`;
  if ((allowed.get(key) ?? 0) > Date.now()) return 200;
  const headers: Record<string, string> = { "x-original-uri": `/${folder}/${parts.join("/")}` };
  const cookie = request.headers.get("cookie");
  const auth = request.headers.get("authorization");
  if (cookie) headers.cookie = cookie;
  if (auth) headers.authorization = auth;
  const res = await fetch(`${API}/api/auth/file-access`, { headers, cache: "no-store" });
  if (res.status === 204) {
    if (allowed.size > 10_000) allowed.clear();
    allowed.set(key, Date.now() + ALLOW_MS);
    return 200;
  }
  return res.status === 401 ? 401 : 404; // someone else's flight looks like no flight
}

export async function serveFieldFile(request: NextRequest, folder: FieldFolder, parts: string[]): Promise<Response> {
  const notFound = () => new Response("Not found", { status: 404 });
  // /<folder>/<flight id>/…: plain names only, and the file must stay inside public/<folder>
  if (parts.length < 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || parts.some((p) => p === "." || p === ".." || /[\\\0]/.test(p))) {
    return notFound();
  }
  const root = path.join(PUBLIC, folder);
  const file = path.join(root, ...parts);
  if (!file.startsWith(root + path.sep)) return notFound();

  const status = await mayRead(request, folder, parts);
  if (status === 401) return new Response("Please sign in", { status: 401 });
  if (status !== 200) return notFound();

  let size: number;
  try {
    const info = await stat(file);
    if (!info.isFile()) return notFound();
    size = info.size;
  } catch {
    return notFound();
  }
  const body = Readable.toWeb(createReadStream(file)) as ReadableStream;
  return new Response(body, {
    headers: {
      "Content-Type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
      "Content-Length": String(size),
      // a rebuilt map (lined up with surveyed points, say) keeps its tile names
      "Cache-Control": "private, max-age=300",
    },
  });
}
