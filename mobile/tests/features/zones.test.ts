import { enrichZones, isWeedZone, mainSpots, spotKind } from "@/features/analysis/zones";
import { jobKind } from "@/services/processing";
import type { DetectionZone, ProcessingJob } from "@/types";

/** A square zone `side` degrees wide with its south-west corner at (lon, lat). */
function zone(id: string, type: string, severity: DetectionZone["severity"], side: number, lon = -85, lat = 36): DetectionZone {
  return {
    id,
    type,
    severity,
    confidence: 0.6,
    geometry: { type: "Polygon", coordinates: [[[lon, lat], [lon + side, lat], [lon + side, lat + side], [lon, lat + side], [lon, lat]]] },
    recommended_action: "Walk to it",
  };
}

describe("spots to check", () => {
  it("ranks how bad times how big: a large thin area outranks a problem speck", () => {
    const speck = zone("speck", "bare_soil", "high", 0.0001); // ~90 m², 0.02 acres
    const big = zone("big", "low_crop_density", "low", 0.001); // ~9000 m², 2.2 acres
    const mid = zone("mid", "bare_soil", "high", 0.0004); // ~1440 m², 0.36 acres
    const ranked = enrichZones([speck, mid, big], null).map((v) => v.zone.id);
    expect(ranked).toEqual(["big", "mid", "speck"]);
  });

  it("measures each spot in acres and keeps specks out of the main list", () => {
    const views = enrichZones([zone("tiny", "bare_soil", "high", 0.00003), zone("ok", "bare_soil", "high", 0.0004)], null);
    const ok = views.find((v) => v.zone.id === "ok");
    expect(ok?.acres).toBeGreaterThan(0.3);
    expect(ok?.acres).toBeLessThan(0.45);
    expect(mainSpots(views).map((v) => v.zone.id)).toEqual(["ok"]);
  });

  it("says where in the field a spot is", () => {
    const [v] = enrichZones([zone("ne", "bare_soil", "high", 0.0002, -84.995, 36.005)], { center: { latitude: 36, longitude: -85 }, boundary: null });
    expect(v?.locationLabel).toBe("North-East area");
  });

  it("tells weeds, problems and thinner areas apart", () => {
    expect(isWeedZone("weed_candidate")).toBe(true);
    expect(isWeedZone("yolo:waterhemp")).toBe(true);
    expect(isWeedZone("bare_soil")).toBe(false);
    expect(spotKind(zone("a", "weed_candidate", "high", 0.0001))).toBe("weeds");
    expect(spotKind(zone("b", "bare_soil", "medium", 0.0001))).toBe("problem");
    expect(spotKind(zone("c", "patchy_vegetation", "low", 0.0001))).toBe("attention");
  });
});

describe("jobKind", () => {
  const job = (keys: string[]): ProcessingJob => ({
    id: "j",
    survey_id: "s",
    status: "PROCESSING",
    current_step: keys[0] ?? null,
    steps: keys.map((key) => ({ key, label: key, status: "pending" as const })),
    error_message: null,
    created_at: null,
    updated_at: null,
  });
  it("recognises each job from its steps (backend processing_service)", () => {
    expect(jobKind(job(["odm_prepare", "odm_reconstruction", "odm_import", "odm_bands", "detailed_analysis", "detailed_ready"]))).toBe("detailed");
    expect(jobKind(job(["gcp_align", "ai_analysis"]))).toBe("gcp");
    expect(jobKind(job(["images_uploaded", "metadata_extracted", "processing_field", "generating_orthomosaic", "ai_analysis", "digital_twin_ready"]))).toBe("full");
    expect(jobKind(job(["generating_orthomosaic", "ai_analysis"]))).toBe("mosaic");
    expect(jobKind(job(["ai_analysis"]))).toBe("analysis");
  });
});
