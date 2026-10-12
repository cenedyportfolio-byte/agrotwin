"""Which of a survey's products wins when several sources provide the same layer.

One table for the analysis, the tile builder and (mirrored in
frontend/lib/surveyAssets.ts) the viewer, so all three pick the same raster:
photogrammetry — OpenDroneMap's own products and the band orthophotos built
on its camera solution (band_ortho_service) — and files the user imported on
purpose rank above the quick direct-georeferenced mosaics.
"""

SOURCE_RANK = {
    "photogrammetry_odm": 0,
    "photogrammetry_gpu": 0,
    "manual_import": 0,
    "direct_georeferencing": 1,
}


def source_rank(source: str) -> int:
    return SOURCE_RANK.get(source, 2)
