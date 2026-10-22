import type { Geometry, Position } from "geojson";

type Bounds = [number, number, number, number];

function rings(g: Geometry): Position[][] {
  if (g.type === "Polygon") return g.coordinates;
  if (g.type === "MultiPolygon") return g.coordinates.flat();
  if (g.type === "GeometryCollection") return g.geometries.flatMap(rings);
  return [];
}

export function boundsOf(geometries: Geometry[]): Bounds | null {
  let b: Bounds | null = null;
  for (const g of geometries)
    for (const ring of rings(g))
      for (const p of ring) {
        const x = p[0] ?? 0;
        const y = p[1] ?? 0;
        b = b ? [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)] : [x, y, x, y];
      }
  return b;
}

/** Fits longitude/latitude shapes into an SVG `width` wide (north up, flat
 * projection around the middle — fine for a field), with `pad` around. */
export function fit(bounds: Bounds, width: number, pad = 6) {
  const [minx, miny, maxx, maxy] = bounds;
  const k = Math.cos((((miny + maxy) / 2) * Math.PI) / 180);
  const w = Math.max((maxx - minx) * k, 1e-9);
  const h = Math.max(maxy - miny, 1e-9);
  const scale = (width - 2 * pad) / w;
  const height = Math.round(h * scale + 2 * pad);
  const project = (p: Position): [number, number] => [pad + ((p[0] ?? 0) - minx) * k * scale, pad + (maxy - (p[1] ?? 0)) * scale];
  const path = (g: Geometry) =>
    rings(g)
      .map((ring) => ring.map((p, i) => `${i ? "L" : "M"}${project(p).map((v) => v.toFixed(1)).join(" ")}`).join("") + "Z")
      .join("");
  return { height, path };
}
