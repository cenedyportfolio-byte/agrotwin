"""RGB-only vegetation analysis via classical computer vision.

This survey has no NIR/Red-Edge band (it's the "100 ft only RGB" capture),
so NDVI/NDRE (multispectral_service.py) can't be computed. Instead this
module computes the Excess Green Index — ExG = 2G - R - B on normalized
chromaticity coordinates (Woebbecke et al. 1995) — a standard, documented
RGB-only vegetation index used for exactly this situation: separating live
vegetation from soil/residue/shadow using only visible-light color.

This is classical pixel-level color-space thresholding on real image data,
not a trained deep-learning model. It measures real vegetation coverage per
photo; it cannot identify weed species, disease, or pest damage. Callers
must not claim more than that.
"""

from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image

MAX_DIM = 640  # downsample for speed — ExG is a color-ratio index, resolution-insensitive
VEGETATION_THRESHOLD = 0.02  # on normalized ExG; standard default from the Woebbecke formulation


@dataclass
class ImageVegetationStats:
    vegetation_fraction: float  # 0..1, share of frame classified as live vegetation
    mean_exg: float  # mean Excess Green Index over the whole frame
    mean_exg_vegetation: float  # mean ExG restricted to vegetation pixels (greenness intensity)


def _decode(path: Path) -> np.ndarray:
    """uint8 HxWx3 at reduced DCT scale. Raises ValueError if unreadable."""
    from app.services.multispectral_service import open_image_safely

    try:
        with open_image_safely(path) as im:
            # draft() lets libjpeg decode at a reduced DCT scale directly —
            # much faster than full decode + resize for a resolution-insensitive index.
            im.draft("RGB", (MAX_DIM, MAX_DIM))
            return np.array(im.convert("RGB"))
    except OSError as exc:
        raise ValueError(f"Could not read image: {path}") from exc


def _stats_numpy(img_u8: np.ndarray) -> ImageVegetationStats:
    img = img_u8.astype(np.float32)
    r, g, b = img[..., 0], img[..., 1], img[..., 2]

    total = np.where((r + g + b) == 0, 1.0, r + g + b)
    rn, gn, bn = r / total, g / total, b / total  # normalize out lighting/exposure differences

    exg = 2 * gn - rn - bn
    veg_mask = exg > VEGETATION_THRESHOLD

    return ImageVegetationStats(
        vegetation_fraction=float(veg_mask.mean()),
        mean_exg=float(exg.mean()),
        mean_exg_vegetation=float(exg[veg_mask].mean()) if veg_mask.any() else 0.0,
    )


def _stats_torch(torch, img_u8: np.ndarray) -> ImageVegetationStats:
    """_stats_numpy on the GPU: same float32 formula; the vegetation share is
    an exact pixel count, so it matches the CPU result exactly."""
    img = torch.from_numpy(img_u8).to("cuda").to(torch.float32)
    r, g, b = img[..., 0], img[..., 1], img[..., 2]
    s = r + g + b
    total = torch.where(s == 0, torch.ones((), device="cuda"), s)
    exg = 2 * (g / total) - r / total - b / total
    veg = exg > VEGETATION_THRESHOLD
    n_veg = int(veg.sum().item())
    return ImageVegetationStats(
        vegetation_fraction=n_veg / veg.numel(),
        mean_exg=float(exg.double().mean().item()),
        mean_exg_vegetation=float(exg[veg].double().mean().item()) if n_veg else 0.0,
    )


def analyze_image_vegetation(path: Path) -> ImageVegetationStats:
    return _stats_numpy(_decode(path))


def analyze_images_vegetation(paths: list[Path]):
    """Yields (path, ImageVegetationStats | ValueError) in input order: JPEGs
    are decoded on a thread pool and the index is computed on the GPU (numpy
    without CUDA). ~10x faster than calling analyze_image_vegetation per frame."""
    from app.services import gpu

    torch = gpu.cuda_torch()

    def decode(path: Path):
        try:
            return _decode(path)
        except ValueError as exc:
            return exc

    for path, img in gpu.prefetch(paths, decode):
        if isinstance(img, ValueError):
            yield path, img
        else:
            yield path, (_stats_torch(torch, img) if torch is not None else _stats_numpy(img))
