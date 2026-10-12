#!/usr/bin/env python3
"""Gaussian-splat PLY -> 3D Tiles with SPZ-compressed KHR_gaussian_splatting glb.

CesiumJS (1.145) renders Gaussian splats only through the
KHR_gaussian_splatting + KHR_gaussian_splatting_compression_spz_2 pair
(its wasm decoder), so the uncompressed layout of the older tile_splat.py
loads but never draws. This writes exactly what the loader expects:

  primitive.extensions.KHR_gaussian_splatting
      .extensions.KHR_gaussian_splatting_compression_spz_2 = {bufferView}
  attributes (accessors without bufferViews): POSITION, COLOR_0,
      KHR_gaussian_splatting:SCALE / :ROTATION / :SH_DEGREE_<l>_COEF_<n>

SPZ v2 (Niantic) packing, from spz/src/cc/load-spz.cc:
  header  NGSP, version 2, numPoints, shDegree, fractionalBits=12, flags, 0
  positions  int24 fixed point  = round(p * 2^12)
  alphas     u8 = sigmoid(opacity_logit) * 255
  colors     u8 = f_dc * (0.15 * 255) + 127.5
  scales     u8 = (log_scale + 10) * 16
  rotations  u8 xyz = q * 127.5 + 127.5, q normalised with w >= 0
  sh         u8 = round(c * 128) + 128, bucketed to 5 bits (degree 1) / 4 bits,
             coefficient-major (r, g, b per coefficient; PLY f_rest is channel-major)
  whole stream gzip-compressed

Placement: identical to tile_splat.py (points recentred on the AABB midpoint,
ENU frame at --lon/--lat/--h). Run with the splat venv (needs plyfile+numpy).
"""

import argparse
import gzip
import json
import math
import struct
import sys
from pathlib import Path

import numpy as np
from plyfile import PlyData

COLOR_SCALE = 0.15
FRACTIONAL_BITS = 12
SH1_BITS, SH_REST_BITS = 5, 4


EARTH_A = 6378137.0
EARTH_E2 = 6.69437999014e-3


def _geodetic_to_ecef(lat, lon, h):
    lat, lon = math.radians(lat), math.radians(lon)
    n = EARTH_A / math.sqrt(1 - EARTH_E2 * math.sin(lat) ** 2)
    return np.array([(n + h) * math.cos(lat) * math.cos(lon), (n + h) * math.cos(lat) * math.sin(lon), (n * (1 - EARTH_E2) + h) * math.sin(lat)])


def _enu_matrix(lat, lon):
    lat, lon = math.radians(lat), math.radians(lon)
    return np.array([
        [-math.sin(lon), math.cos(lon), 0],
        [-math.sin(lat) * math.cos(lon), -math.sin(lat) * math.sin(lon), math.cos(lat)],
        [math.cos(lat) * math.cos(lon), math.cos(lat) * math.sin(lon), math.sin(lat)],
    ])


def enu_to_geodetic(e, n, u, lat0, lon0, h0):
    x, y, z = _geodetic_to_ecef(lat0, lon0, h0) + _enu_matrix(lat0, lon0).T @ np.array([e, n, u])
    lon = math.atan2(y, x)
    p = math.hypot(x, y)
    lat = math.atan2(z, p * (1 - EARTH_E2))
    for _ in range(5):
        nn = EARTH_A / math.sqrt(1 - EARTH_E2 * math.sin(lat) ** 2)
        h = p / math.cos(lat) - nn
        lat = math.atan2(z, p * (1 - EARTH_E2 * nn / (nn + h)))
    return math.degrees(lat), math.degrees(lon), h


def lonlat_to_ecef(lon, lat, h):
    return _geodetic_to_ecef(lat, lon, h)


def enu_to_ecef_matrix(lon, lat):
    """Columns are the ENU basis vectors (E, N, U) expressed in ECEF."""
    return _enu_matrix(lat, lon).T


def _u8(x: np.ndarray) -> np.ndarray:
    return np.clip(np.rint(x), 0, 255).astype(np.uint8)


def read_ply(path: Path):
    v = PlyData.read(str(path))["vertex"]
    names = v.data.dtype.names
    pos = np.stack([v["x"], v["y"], v["z"]], axis=1).astype(np.float32)
    f_dc = np.stack([v[f"f_dc_{i}"] for i in range(3)], axis=1).astype(np.float32)
    rest_names = sorted([n for n in names if n.startswith("f_rest_")], key=lambda n: int(n.split("_")[-1]))
    f_rest = np.stack([v[n] for n in rest_names], axis=1).astype(np.float32) if rest_names else np.zeros((len(pos), 0), np.float32)
    opacity = np.asarray(v["opacity"], np.float32)
    scale = np.stack([v[f"scale_{i}"] for i in range(3)], axis=1).astype(np.float32)
    rot = np.stack([v[f"rot_{i}"] for i in range(4)], axis=1).astype(np.float32)  # w, x, y, z
    return pos, f_dc, f_rest, opacity, scale, rot


def encode_spz(pos, f_dc, f_rest, opacity, log_scale, rot_wxyz) -> tuple[bytes, int]:
    n = len(pos)
    sh_dim = f_rest.shape[1] // 3
    sh_degree = {0: 0, 3: 1, 8: 2, 15: 3}[sh_dim]

    fixed = np.rint(pos.astype(np.float64) * (1 << FRACTIONAL_BITS)).astype(np.int32).reshape(-1)
    pos_bytes = np.stack([fixed & 0xFF, (fixed >> 8) & 0xFF, (fixed >> 16) & 0xFF], axis=1).astype(np.uint8).tobytes()

    alphas = _u8(255.0 / (1.0 + np.exp(-opacity)))
    colors = _u8(f_dc * (COLOR_SCALE * 255.0) + 127.5)
    scales = _u8((log_scale + 10.0) * 16.0)

    q = rot_wxyz / np.linalg.norm(rot_wxyz, axis=1, keepdims=True).clip(min=1e-12)
    q = np.where(q[:, :1] < 0, -q, q)  # w >= 0 so xyz alone reconstructs it
    rotations = _u8(q[:, 1:4] * 127.5 + 127.5)

    if sh_dim:
        # PLY f_rest is channel-major (all red coefficients, then green, then
        # blue — gsplat's export_splats permutes (N, K, 3) -> (N, 3, K) like the
        # reference 3DGS writer); SPZ wants coefficient-major (r, g, b per
        # coefficient). Copying it through unchanged scrambled the
        # view-dependent colour into pink/purple speckle in Cesium.
        coef_major = f_rest.reshape(n, 3, sh_dim).transpose(0, 2, 1).reshape(n, sh_dim * 3)
        raw = np.rint(coef_major * 128.0) + 128.0
        bucket = np.full(sh_dim * 3, 1 << (8 - SH_REST_BITS), np.float64)
        bucket[:9] = 1 << (8 - SH1_BITS)
        quant = np.floor((raw + bucket / 2) / bucket) * bucket
        sh = _u8(quant)
    else:
        sh = np.zeros((n, 0), np.uint8)

    header = struct.pack("<IIIBBBB", 0x5053474E, 2, n, sh_degree, FRACTIONAL_BITS, 0, 0)
    raw_stream = header + pos_bytes + alphas.tobytes() + colors.tobytes() + scales.tobytes() + rotations.tobytes() + sh.tobytes()
    return gzip.compress(raw_stream, compresslevel=6), sh_degree


def prune_floaters(pos, opacity, log_scale, band_m: float, min_opacity: float = 0.05, max_scale_m: float = 3.0) -> np.ndarray:
    """Nadir drone captures leave 'floaters' — large, faint Gaussians hanging
    between the ground and the camera height — which fill the view when the
    camera is near them. The ground is where most splats are: take the
    median height (glTF y = up in build_splats' frame) and keep a band
    around it, plus drop near-transparent and enormous splats."""
    y = pos[:, 1]
    ground = float(np.median(y))
    keep = (np.abs(y - ground) < band_m)
    keep &= (1.0 / (1.0 + np.exp(-opacity))) > min_opacity
    keep &= np.exp(log_scale).max(axis=1) < max_scale_m
    print(f"prune: ground y≈{ground:.1f} m, keeping {int(keep.sum())}/{len(keep)} splats "
          f"(dropped {len(keep) - int(keep.sum())} floaters / faint / oversized)")
    return keep


def prune_needles(log_scale, rot_wxyz, ratio: float = 8.0, min_len_m: float = 0.2, up_cos: float = 0.7) -> np.ndarray:
    """Drops 'needles': Gaussians stretched far more along one axis than the
    next (longest/middle > ratio) whose long axis is near-vertical. With a
    nadir-only capture, depth along the (vertical) viewing rays is the least
    constrained direction, so these are reconstruction artefacts, not
    surface — they read as spikes from any low viewing angle."""
    s = np.sort(log_scale, axis=1)
    elongated = (np.exp(s[:, 2] - s[:, 1]) > ratio) & (np.exp(s[:, 2]) > min_len_m)
    q = rot_wxyz / np.linalg.norm(rot_wxyz, axis=1, keepdims=True)
    w, x, y, z = q[:, 0], q[:, 1], q[:, 2], q[:, 3]
    # y-row of R (world up in the glTF frame) dotted with the longest local axis
    up_row = np.stack([2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)], axis=1)
    longest = np.argmax(log_scale, axis=1)
    vertical = np.abs(up_row[np.arange(len(q)), longest]) > up_cos
    drop = elongated & vertical
    print(f"prune: dropped {int(drop.sum())} vertical needles (ratio>{ratio}, len>{min_len_m} m)")
    return ~drop


def build_glb(pos_centered: np.ndarray, spz: bytes, sh_degree: int, n: int, lo, hi, out: Path) -> None:
    pad = (-len(spz)) % 4
    bin_chunk = spz + b"\x00" * pad

    accessors = [
        {"componentType": 5126, "count": n, "type": "VEC3", "min": lo.tolist(), "max": hi.tolist()},  # 0 POSITION
        {"componentType": 5121, "count": n, "type": "VEC4", "normalized": True},  # 1 COLOR_0
        {"componentType": 5126, "count": n, "type": "VEC3"},  # 2 SCALE
        {"componentType": 5126, "count": n, "type": "VEC4"},  # 3 ROTATION
    ]
    attributes = {
        "POSITION": 0,
        "COLOR_0": 1,
        "KHR_gaussian_splatting:SCALE": 2,
        "KHR_gaussian_splatting:ROTATION": 3,
    }
    per_degree = {1: 3, 2: 5, 3: 7}
    for degree in range(1, sh_degree + 1):
        for coef in range(per_degree[degree]):
            attributes[f"KHR_gaussian_splatting:SH_DEGREE_{degree}_COEF_{coef}"] = len(accessors)
            accessors.append({"componentType": 5126, "count": n, "type": "VEC3"})

    gltf = {
        "asset": {"version": "2.0", "generator": "agrotwin tile_splats_spz.py"},
        "extensionsUsed": ["KHR_gaussian_splatting", "KHR_gaussian_splatting_compression_spz_2"],
        "extensionsRequired": ["KHR_gaussian_splatting", "KHR_gaussian_splatting_compression_spz_2"],
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0}],
        "meshes": [
            {
                "primitives": [
                    {
                        "mode": 0,
                        "attributes": attributes,
                        "extensions": {
                            "KHR_gaussian_splatting": {
                                "kernel": "ellipse",
                                "colorSpace": "srgb_rec709_display",
                                "sortingMethod": "cameraDistance",
                                "projection": "perspective",
                                "extensions": {"KHR_gaussian_splatting_compression_spz_2": {"bufferView": 0}},
                            }
                        },
                    }
                ]
            }
        ],
        "accessors": accessors,
        "bufferViews": [{"buffer": 0, "byteOffset": 0, "byteLength": len(spz)}],
        "buffers": [{"byteLength": len(bin_chunk)}],
    }
    js = json.dumps(gltf, separators=(",", ":")).encode()
    js += b" " * ((-len(js)) % 4)
    total = 12 + 8 + len(js) + 8 + len(bin_chunk)
    with open(out, "wb") as f:
        f.write(struct.pack("<III", 0x46546C67, 2, total))
        f.write(struct.pack("<II", len(js), 0x4E4F534A))
        f.write(js)
        f.write(struct.pack("<II", len(bin_chunk), 0x004E4942))
        f.write(bin_chunk)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ply", required=True)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--lon0", type=float, required=True, help="ENU origin of the model frame (from build_splats geo.json)")
    ap.add_argument("--lat0", type=float, required=True)
    ap.add_argument("--h0", type=float, required=True)
    ap.add_argument("--yaw-deg", type=float, default=0.0)
    ap.add_argument("--ground-at-ellipsoid", action=argparse.BooleanOptionalAction, default=True,
                    help="place the cloud's ground plane at ellipsoid height 0 (the viewer has no terrain)")
    ap.add_argument("--ground-band", type=float, default=15.0,
                    help="keep splats within ± this many metres of the ground plane (glTF y, up)")
    ap.add_argument("--min-opacity", type=float, default=0.05, help="drop fainter splats (floaters are faint and large)")
    ap.add_argument("--max-scale", type=float, default=3.0, help="drop splats whose longest axis exceeds this (m)")
    ap.add_argument("--max-radius", type=float, default=250.0,
                    help="drop splats farther than this (m) from the survey centre horizontally (0 = keep all)")
    ap.add_argument("--prune-needles", action=argparse.BooleanOptionalAction, default=True,
                    help="drop near-vertical, highly elongated Gaussians (nadir-capture depth artefacts)")
    ap.add_argument("--train-gsd-m", type=float, default=None,
                    help="ground size of one training pixel; recorded so the viewer limits zoom to it")
    args = ap.parse_args()

    pos, f_dc, f_rest, opacity, scale, rot = read_ply(Path(args.ply))
    keep = prune_floaters(pos, opacity, scale, args.ground_band, args.min_opacity, args.max_scale)
    if args.prune_needles:
        keep &= prune_needles(scale, rot)
    if args.max_radius > 0:
        # horizontal distance from the ENU origin (mean camera position): stray
        # splats hundreds of metres out inflate the tile's bounding volume
        far = np.hypot(pos[:, 0], pos[:, 2]) > args.max_radius
        print(f"prune: dropped {int((keep & far).sum())} splats beyond {args.max_radius:.0f} m of the survey centre")
        keep &= ~far
    pos, f_dc, f_rest, opacity, scale, rot = pos[keep], f_dc[keep], f_rest[keep], opacity[keep], scale[keep], rot[keep]
    lo, hi = pos.min(axis=0), pos.max(axis=0)
    center = ((lo + hi) / 2).astype(np.float32)
    local = pos - center
    print(f"{len(pos)} splats, SH degree {f_rest.shape[1] // 3 and {3: 1, 8: 2, 15: 3}[f_rest.shape[1] // 3]}")

    spz, sh_degree = encode_spz(local, f_dc, f_rest, opacity, scale, rot)
    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    build_glb(local, spz, sh_degree, len(pos), lo - center, hi - center, out / "splat.glb")

    # The tile origin is the (pruned) cloud's AABB midpoint. glTF frame is
    # (E, U, -N) — see build_splats._ENU_TO_GLTF — so ENU of the midpoint is:
    e, u, n = float(center[0]), float(center[1]), float(-center[2])
    lat, lon, h = enu_to_geodetic(e, n, u, args.lat0, args.lon0, args.h0)
    if args.ground_at_ellipsoid:
        # The viewer renders a flat ellipsoid (no terrain), with imagery and
        # boundaries at height 0. Put the reconstruction's ground plane
        # there too, instead of floating at its true ~263 m ellipsoidal
        # height above an unrendered hillside.
        ground_u = float(np.median(pos[:, 1]))
        h = u - ground_u
    print(f"placement: AABB midpoint ENU=({e:.1f}, {n:.1f}, {u:.1f}) -> lon {lon:.8f} lat {lat:.8f} h {h:.2f}")

    half = ((hi - lo) / 2).tolist()
    yaw = math.radians(args.yaw_deg)
    cy, sy = math.cos(yaw), math.sin(yaw)
    R = enu_to_ecef_matrix(lon, lat) @ np.array([[cy, -sy, 0], [sy, cy, 0], [0, 0, 1]])
    T = np.eye(4)
    T[:3, :3], T[:3, 3] = R, lonlat_to_ecef(lon, lat, h)
    gltf_exts = ["KHR_gaussian_splatting", "KHR_gaussian_splatting_compression_spz_2"]
    tileset = {
        "asset": {"version": "1.1", "tilesetVersion": "1.0.0"},
        # Cesium enables its splat renderer only when the tileset declares the
        # glTF extensions as *required* via 3DTILES_content_gltf.
        "extensionsUsed": ["3DTILES_content_gltf"],
        "extensionsRequired": ["3DTILES_content_gltf"],
        "extensions": {"3DTILES_content_gltf": {"extensionsUsed": gltf_exts, "extensionsRequired": gltf_exts}},
        "geometricError": float(max(half) * 4 + 10.0),
        "root": {
            "transform": T.T.reshape(-1).tolist(),
            "boundingVolume": {"box": [0, 0, 0, half[0], 0, 0, 0, half[1], 0, 0, 0, half[2]]},
            "geometricError": 0.0,
            "refine": "ADD",
            "content": {"uri": "splat.glb"},
        },
    }
    (out / "tileset.json").write_text(json.dumps(tileset, indent=1))
    placement = {"lon": lon, "lat": lat, "h": h, "lat0": args.lat0, "lon0": args.lon0, "h0": args.h0, "splats": len(pos)}
    if args.train_gsd_m:
        placement["train_gsd_m"] = args.train_gsd_m
    (out / "placement.json").write_text(json.dumps(placement, indent=2))
    print(f"Wrote {out / 'tileset.json'} + splat.glb ({(out / 'splat.glb').stat().st_size / 1e6:.1f} MB, SPZ)")


if __name__ == "__main__":
    sys.exit(main())
