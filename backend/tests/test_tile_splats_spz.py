"""The SPZ writer must reorder spherical-harmonic coefficients: PLY f_rest is
channel-major (all red coefficients, then green, then blue) while SPZ stores
them coefficient-major (r, g, b per coefficient). Mixing the two scrambles
the view-dependent colour of every splat.

Run (from backend/):  python -m tests.test_tile_splats_spz
"""

import gzip
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from scripts.tile_splats_spz import encode_spz  # noqa: E402

HEADER_BYTES = 16


def test_sh_is_written_coefficient_major():
    k = 15  # degree 3
    # channel-major like a gsplat/3DGS PLY: red coefficients 0.5, green 0, blue -0.5
    f_rest = np.concatenate([np.full(k, 0.5), np.zeros(k), np.full(k, -0.5)])[None].astype(np.float32)
    spz, degree = encode_spz(np.zeros((1, 3), np.float32), np.zeros((1, 3), np.float32), f_rest,
                             np.zeros(1, np.float32), np.zeros((1, 3), np.float32),
                             np.array([[1, 0, 0, 0]], np.float32))
    assert degree == 3
    stream = gzip.decompress(spz)
    n = 1
    sh = np.frombuffer(stream, np.uint8, offset=HEADER_BYTES + n * (9 + 1 + 3 + 3 + 3))
    assert sh.tolist() == [192, 128, 64] * k, sh.tolist()


def main():
    test_sh_is_written_coefficient_major()
    print("tile_splats_spz: all checks passed")


if __name__ == "__main__":
    main()
