import { View } from "react-native";
import { useMapLayerStore, type MapLayerKey } from "@/stores/mapLayerStore";
import { BottomSheet, CheckRow, ListGroup, AppText } from "@/components/ui";
import type { RasterLayerKey, RasterSource } from "./mapLayers";

interface LayerSheetProps {
  visible: boolean;
  onClose: () => void;
  rasters: Partial<Record<RasterLayerKey, RasterSource>>;
  hasZones: boolean;
  hasImages: boolean;
  hasBoundary: boolean;
  hasVectorOverlays: boolean;
}

interface Def {
  key: MapLayerKey;
  label: string;
  note?: string;
  enabled: boolean;
}

/** Canvas "Map layers" sheet: Basic (boundary / health / problems) and Advanced check-rows. */
export function LayerSheet({ visible, onClose, rasters, hasZones, hasImages, hasBoundary, hasVectorOverlays }: LayerSheetProps) {
  const layers = useMapLayerStore((s) => s.layers);
  const toggle = useMapLayerStore((s) => s.toggleLayer);

  const basic: Def[] = [
    { key: "field", label: "Field boundary", enabled: hasBoundary },
    { key: "zones", label: "Problem areas", enabled: hasZones },
    { key: "orthomosaic", label: "Stitched field map", note: "Orthomosaic", enabled: !!rasters.orthomosaic },
    { key: "vectorOverlays", label: "Imported boundaries", note: "GeoJSON", enabled: hasVectorOverlays },
  ];
  const advanced: Def[] = [
    { key: "ndvi", label: "Vegetation index", note: "NDVI", enabled: !!rasters.ndvi },
    { key: "ndre", label: "Leaf nitrogen index", note: "NDRE", enabled: !!rasters.ndre },
    { key: "gndvi", label: "Green index", note: "GNDVI", enabled: !!rasters.gndvi },
    { key: "dsm", label: "Elevation", note: "DSM", enabled: !!rasters.dsm },
    { key: "imagePoints", label: "Photo locations", note: hasImages ? "GPS" : "No GPS", enabled: hasImages },
    { key: "cropDensity", label: "Crop density", note: hasImages ? "Per photo" : "No photos", enabled: hasImages },
  ];

  const group = (defs: Def[]) => (
    <ListGroup>
      {defs.map((d, i) => (
        <CheckRow key={d.key} label={d.label} note={d.enabled ? d.note : d.note ? `${d.note} · not available for this survey` : "Not available for this survey"} checked={layers[d.key] && d.enabled} onPress={() => toggle(d.key)} disabled={!d.enabled} last={i === defs.length - 1} />
      ))}
    </ListGroup>
  );

  return (
    <BottomSheet visible={visible} onClose={onClose} title="Map layers">
      <AppText variant="kicker" tone="muted" style={{ marginBottom: 8 }}>
        Basic
      </AppText>
      <View style={{ marginBottom: 16 }}>{group(basic)}</View>
      <AppText variant="kicker" tone="muted" style={{ marginBottom: 8 }}>
        Advanced
      </AppText>
      {group(advanced)}
    </BottomSheet>
  );
}
