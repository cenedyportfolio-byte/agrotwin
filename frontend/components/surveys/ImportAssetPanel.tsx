"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { UploadCloud, Trash2, Loader2, Layers } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";

const ASSET_TYPES: { value: string; label: string; accept: string; hint: string }[] = [
  { value: "orthomosaic", label: "Orthomosaic (GeoTIFF)", accept: ".tif,.tiff", hint: "Georeferenced RGB orthophoto from ODM/WebODM, DJI Terra or Metashape" },
  { value: "ndvi", label: "NDVI (GeoTIFF)", accept: ".tif,.tiff", hint: "Single-band index raster, georeferenced" },
  { value: "ndre", label: "NDRE (GeoTIFF)", accept: ".tif,.tiff", hint: "Single-band index raster, georeferenced" },
  { value: "gndvi", label: "GNDVI (GeoTIFF)", accept: ".tif,.tiff", hint: "Single-band index raster, georeferenced" },
  { value: "dsm", label: "Elevation / DSM (GeoTIFF)", accept: ".tif,.tiff", hint: "Single-band surface model, georeferenced" },
  { value: "geojson", label: "Boundaries / zones (GeoJSON)", accept: ".geojson,.json", hint: "WGS84 longitude/latitude features — drawn on the map as an overlay" },
  { value: "model3d", label: "3D model (Cesium 3D Tiles .zip)", accept: ".zip", hint: "Export the textured model as 3D Tiles (Metashape, DJI Terra, ODM --3d-tiles) and zip the folder with tileset.json" },
  { value: "pointcloud", label: "Point cloud (LAS / LAZ)", accept: ".las,.laz", hint: "Georeferenced point cloud; tiled here for streaming" },
];

const ASSET_TYPE_LABEL: Record<string, string> = {
  orthomosaic: "Orthomosaic",
  ndvi: "NDVI",
  ndre: "NDRE",
  gndvi: "GNDVI",
  model3d: "3D Model",
  tileset: "3D Tileset",
  pointcloud: "Point Cloud",
  pointcloud_laz: "Point Cloud (LAZ)",
  dsm: "Elevation (DSM)",
  dtm: "Bare earth (DTM)",
  geojson: "Vector overlay (GeoJSON)",
  band_green: "Green band (560 nm)",
  band_red: "Red band (650 nm)",
  band_red_edge: "Red Edge band (730 nm)",
  band_nir: "NIR band (860 nm)",
  false_color: "False colour (NIR·R·G)",
  alignment_check: "Alignment check (NIR vs photo)",
  vegetation_mask: "Vegetation mask",
  gnss_timestamp_mrk: "RTK timestamps (.MRK)",
  gnss_ppk_nav: "PPK navigation (.nav)",
  gnss_ppk_obs: "PPK observations (.obs)",
  gnss_ppk_raw: "PPK raw log (.bin)",
};

const FORMAT_LABEL: Record<string, string> = {
  xyz: "TILE PYRAMID",
  "3dtiles": "3D TILES",
};

function describeSource(asset: { asset_type: string; source: string; bounds_geojson: string | null }) {
  if (asset.asset_type.startsWith("gnss_")) return "from the DJI mission folder · positions already RTK-fixed in flight";
  switch (asset.source) {
    case "direct_georeferencing":
      return "quick mosaic built from this survey's frames · georeferenced";
    case "photogrammetry_odm":
      return "true photogrammetry (OpenDroneMap) from this survey's frames";
    case "photogrammetry_gpu":
      return "band frames placed on the OpenDroneMap cameras and surface model (GPU) · lines up with the photo";
    case "analysis":
      return "from the analysis · georeferenced";
    case "photogrammetry":
      return "derived from the splat reconstruction";
    case "manual_import":
      return asset.bounds_geojson ? "imported · georeferenced" : "imported";
    default:
      return asset.bounds_geojson ? "georeferenced" : "no bounds detected";
  }
}

export function ImportAssetPanel({ surveyId, disabled }: { surveyId: string; disabled?: boolean }) {
  const qc = useQueryClient();
  const [assetType, setAssetType] = useState("orthomosaic");
  const [file, setFile] = useState<File | null>(null);
  const selected = ASSET_TYPES.find((t) => t.value === assetType) ?? ASSET_TYPES[0];

  const { data: assets } = useQuery({
    queryKey: ["survey-assets", surveyId],
    queryFn: () => api.listSurveyAssets(surveyId),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["survey-assets", surveyId] });
    qc.invalidateQueries({ queryKey: ["survey-availability", surveyId] });
  };

  const upload = useMutation({
    mutationFn: () => {
      if (!file) throw new Error("Choose a file first");
      return api.uploadSurveyAsset(surveyId, assetType, file);
    },
    onSuccess: () => {
      setFile(null);
      invalidate();
    },
  });

  const remove = useMutation({
    mutationFn: (assetId: string) => api.deleteSurveyAsset(surveyId, assetId),
    onSuccess: invalidate,
  });

  return (
    <div className="rounded-xl border border-border bg-surface p-5 space-y-4">
      <div className="flex items-center gap-2">
        <Layers size={16} className="text-brand" />
        <h2 className="font-semibold text-sm">Import Processed Data</h2>
      </div>
      <p className="text-xs text-muted-foreground">
        Import results from ODM/WebODM, DJI Terra or Metashape. Only georeferenced files are accepted — their
        placement is read from the file itself and shown in the Digital Twin at its real location.
      </p>

      <div className="flex flex-col @xl:flex-row gap-2">
        <select
          value={assetType}
          onChange={(e) => {
            setAssetType(e.target.value);
            setFile(null);
          }}
          className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-brand"
        >
          {ASSET_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
        <label className="flex flex-1 cursor-pointer items-center gap-2 rounded-lg border border-dashed border-border bg-surface-2 px-3 py-2 text-sm text-muted-foreground hover:border-brand/50">
          <UploadCloud size={15} />
          <span className="truncate">{file ? file.name : "Choose file"}</span>
          <input
            key={assetType}
            type="file"
            accept={selected.accept}
            className="hidden"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </label>
        <Button size="lg" onClick={() => upload.mutate()} disabled={!file || upload.isPending || disabled}>
          {upload.isPending && <Loader2 className="animate-spin" />}
          {upload.isPending ? "Importing…" : "Import"}
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground">{selected.hint}</p>
      {upload.isError && <div className="text-xs text-problem">{(upload.error as Error).message}</div>}

      {assets && assets.length > 0 && (
        <div className="space-y-1.5 pt-2 border-t border-border">
          {assets.map((asset) => (
            <div key={asset.id} className="flex items-center justify-between gap-3 text-xs">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 min-w-0">
                <span className="font-medium">{ASSET_TYPE_LABEL[asset.asset_type] ?? asset.asset_type}</span>
                <span className="text-muted-foreground">
                  {(asset.format && FORMAT_LABEL[asset.format]) ?? asset.format?.toUpperCase()} · {describeSource(asset)}
                </span>
              </div>
              {asset.source === "manual_import" && (
                <button
                  onClick={() => remove.mutate(asset.id)}
                  disabled={remove.isPending}
                  className="shrink-0 text-muted-foreground hover:text-problem"
                  title="Remove imported file"
                >
                  <Trash2 size={14} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {remove.isError && <div className="text-xs text-problem">{(remove.error as Error).message}</div>}
    </div>
  );
}
