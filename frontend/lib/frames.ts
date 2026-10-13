import type { SurveyImage } from "@/lib/types";

export const BAND_ORDER = ["RGB", "GREEN", "RED", "RED_EDGE", "NIR", "THERMAL"];

export const BAND_LABEL: Record<string, string> = {
  RGB: "RGB",
  GREEN: "Green",
  RED: "Red",
  RED_EDGE: "Red Edge",
  NIR: "NIR",
  THERMAL: "Thermal",
};

// Mirrors INDEX_BANDS in backend/app/services/multispectral_service.py.
export const INDEX_BANDS = {
  ndvi: ["NIR", "RED"],
  ndre: ["NIR", "RED_EDGE"],
  gndvi: ["NIR", "GREEN"],
} as const;

export type IndexKey = keyof typeof INDEX_BANDS;

export const INDEX_LABEL: Record<IndexKey, string> = {
  ndvi: "NDVI",
  ndre: "NDRE",
  gndvi: "GNDVI",
};

/** How the crop health was measured, in a farmer's words (the detail is in METHOD_DESCRIPTION). */
export const METHOD_LABEL: Record<string, string> = {
  ndvi_map: "Crop-health camera",
  exg_map: "Photo greenness",
  ndvi: "Crop-health camera, per photo",
  exg: "Photo greenness, per photo",
};

export const METHOD_DESCRIPTION: Record<string, string> = {
  ndvi_map: "Measured with the drone's near-infrared crop-health camera (NDVI) on the field map, in 5 m (16 ft) squares.",
  exg_map: "Measured from how green the normal photos are (Excess Green index) on the field map, in 5 m (16 ft) squares. A drone with a crop-health (multispectral) camera measures more reliably.",
  ndvi: "Measured photo by photo with the near-infrared crop-health camera (NDVI); overlapping photos count twice.",
  exg: "Measured photo by photo from how green the normal photos are (Excess Green index); overlapping photos count twice.",
};

export interface Frame {
  key: string;
  /** Preferred display image for this frame — the RGB band when present. */
  anchor: SurveyImage;
  bands: Record<string, SurveyImage>;
  indices: IndexKey[];
}

/** Groups a survey's images by shutter release (a multispectral frame is
 * several band files sharing one frame_key) — mirrors Survey.frame_count. */
export function groupFrames(images: SurveyImage[]): Frame[] {
  const groups = new Map<string, SurveyImage[]>();
  for (const img of images) {
    const key = img.frame_key ?? img.id;
    const list = groups.get(key);
    if (list) list.push(img);
    else groups.set(key, [img]);
  }

  const frames: Frame[] = Array.from(groups.entries()).map(([key, members]) => {
    const bands: Record<string, SurveyImage> = {};
    for (const img of members) bands[img.band] = img;
    const anchor = bands.RGB ?? members[0];
    const indices = (Object.keys(INDEX_BANDS) as IndexKey[]).filter((idx) =>
      INDEX_BANDS[idx].every((band) => !!bands[band])
    );
    return { key, anchor, bands, indices };
  });

  return frames.sort((a, b) => (a.anchor.captured_at ?? "").localeCompare(b.anchor.captured_at ?? ""));
}
