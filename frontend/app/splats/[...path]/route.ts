import type { NextRequest } from "next/server";
import { serveFieldFile } from "@/lib/server/fieldFiles";

/** A flight's splats file written after this website was built (see lib/server/fieldFiles). */
export async function GET(request: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return serveFieldFile(request, "splats", (await params).path);
}
