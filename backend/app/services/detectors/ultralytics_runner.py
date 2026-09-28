"""Runs an Ultralytics (YOLO / YOLO-seg) model over the orthomosaic in
georeferenced tiles and returns detections as WGS84 polygons.

Only used when data/models/<name>/manifest.json declares framework
"ultralytics" and the `ultralytics` package is installed (see
detector_service.list_detectors). Tiles are read at the model's input GSD so
a 2 cm mosaic is not fed to a model trained on 5 cm pixels.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np

from app.services.detector_service import DetectorInfo, ModelDetection

TILE_PX = 1024
OVERLAP_PX = 128
MIN_CONFIDENCE = 0.25


class UltralyticsDetector:
    def __init__(self, info: DetectorInfo):
        from ultralytics import YOLO

        self.info = info
        self.model = YOLO(str(info.weights))

    def detect(self, orthomosaic: Path) -> list[ModelDetection]:
        import rasterio
        from rasterio.enums import Resampling
        from rasterio.warp import transform as warp_transform
        from rasterio.windows import Window
        from shapely.geometry import Polygon, box, mapping

        out: list[ModelDetection] = []
        with rasterio.open(orthomosaic) as src:
            native = abs(src.transform.a)
            gsd = self.info.input_gsd_m or native
            scale = gsd / native  # source pixels per model pixel
            step = int((TILE_PX - OVERLAP_PX) * scale)
            win_px = int(TILE_PX * scale)
            for row0 in range(0, src.height, step):
                for col0 in range(0, src.width, step):
                    w, h = min(win_px, src.width - col0), min(win_px, src.height - row0)
                    if w < 64 * scale or h < 64 * scale:
                        continue
                    data = src.read(
                        [1, 2, 3], window=Window(col0, row0, w, h),
                        out_shape=(3, int(h / scale), int(w / scale)), resampling=Resampling.average,
                    )
                    if not np.any(data):
                        continue
                    img = np.transpose(data, (1, 2, 0))
                    for r in self.model.predict(img, verbose=False, conf=MIN_CONFIDENCE):
                        names = r.names
                        polys = []
                        if getattr(r, "masks", None) is not None and r.masks is not None:
                            for seg, cls, conf in zip(r.masks.xy, r.boxes.cls.tolist(), r.boxes.conf.tolist()):
                                if len(seg) >= 3:
                                    polys.append((Polygon(seg), names[int(cls)], float(conf)))
                        else:
                            for (x0, y0, x1, y1), cls, conf in zip(r.boxes.xyxy.tolist(), r.boxes.cls.tolist(), r.boxes.conf.tolist()):
                                polys.append((box(x0, y0, x1, y1), names[int(cls)], float(conf)))
                        for poly, label, conf in polys:
                            xs, ys = poly.exterior.coords.xy
                            px = [col0 + x * scale for x in xs]
                            py = [row0 + y * scale for y in ys]
                            mx, my = zip(*[src.transform * (x, y) for x, y in zip(px, py)])
                            lons, lats = warp_transform(src.crs, "EPSG:4326", list(mx), list(my))
                            geom = Polygon(zip(lons, lats)).buffer(0)
                            if geom.is_empty:
                                continue
                            out.append(ModelDetection(type=str(label), confidence=conf, geometry=mapping(geom), detector=self.info.name))
        return out
