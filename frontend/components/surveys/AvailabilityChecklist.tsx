import { Check, Circle } from "lucide-react";
import type { SurveyAvailability } from "@/lib/types";

const ITEMS: { key: keyof SurveyAvailability; label: string }[] = [
  { key: "rgb_images", label: "RGB Images" },
  { key: "gps_metadata", label: "GPS Metadata" },
  { key: "multispectral", label: "Multispectral" },
  { key: "nir", label: "NIR" },
  { key: "red_edge", label: "Red Edge" },
  { key: "thermal", label: "Thermal" },
  { key: "orthomosaic", label: "Orthomosaic" },
  { key: "model_3d", label: "3D Model" },
  { key: "pointcloud", label: "Point Cloud" },
  { key: "gnss_ppk", label: "GNSS / PPK Files" },
  { key: "dsm", label: "Elevation Model (DSM)" },
  { key: "vector_overlays", label: "Boundaries / Zones (GeoJSON)" },
];

export function AvailabilityChecklist({ availability }: { availability: SurveyAvailability }) {
  return (
    <div className="grid grid-cols-2 @3xl:grid-cols-3 gap-2">
      {ITEMS.map(({ key, label }) => {
        const available = availability[key];
        return (
          <div key={key} className="flex items-center gap-2 text-sm">
            {available ? (
              <Check size={15} className="text-healthy shrink-0" />
            ) : (
              <Circle size={15} className="text-muted-foreground shrink-0" />
            )}
            <span className={available ? "" : "text-muted-foreground"}>{label}</span>
          </div>
        );
      })}
    </div>
  );
}
