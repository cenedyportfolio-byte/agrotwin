import { View } from "react-native";
import { BAND_LABEL } from "@/constants/labels";
import type { SurveyImage } from "@/types";
import { formatDateTime, formatFeet, formatPercent } from "@/utils/format";
import { Disclosure, KeyValueRow, AppText } from "@/components/ui";

interface ImageMetadataProps {
  image: SurveyImage;
  drone?: string | null;
  advanced?: boolean;
}

function coord(value: number | null, positive: string, negative: string): string {
  if (value == null) return "—";
  return `${Math.abs(value).toFixed(4)}° ${value >= 0 ? positive : negative}`;
}

/** Canvas "Image details" rows: GPS latitude / longitude / altitude / camera / captured, plus advanced camera geometry. */
export function ImageMetadata({ image, drone, advanced = false }: ImageMetadataProps) {
  return (
    <View>
      <AppText variant="cardTitle" style={{ fontSize: 22 }}>
        Image details
      </AppText>
      <AppText variant="caption" tone="muted" style={{ marginBottom: 10 }} numberOfLines={1}>
        {image.filename}
      </AppText>
      <KeyValueRow label="GPS latitude" value={coord(image.lat, "N", "S")} />
      <KeyValueRow label="GPS longitude" value={coord(image.lon, "E", "W")} />
      <KeyValueRow label="Altitude" value={image.rel_altitude_m != null ? `${formatFeet(image.rel_altitude_m)} above takeoff` : formatFeet(image.altitude_m)} />
      <KeyValueRow label="Camera" value={drone ?? "Unknown"} />
      <KeyValueRow label="Captured" value={formatDateTime(image.captured_at)} />
      <KeyValueRow label="Band" value={BAND_LABEL[image.band] ?? image.band} />
      <KeyValueRow label="Vegetation cover" value={image.vegetation_fraction != null ? formatPercent(image.vegetation_fraction * 100) : "Not analysed"} last={!advanced} />
      <Disclosure showLabel="Show advanced details" hideLabel="Hide advanced details" defaultOpen={advanced}>
        <KeyValueRow label="Resolution" value={image.width && image.height ? `${image.width} × ${image.height}` : "—"} />
        <KeyValueRow label="Gimbal yaw" value={image.gimbal_yaw_deg != null ? `${image.gimbal_yaw_deg.toFixed(1)}°` : "—"} />
        <KeyValueRow label="Gimbal pitch" value={image.gimbal_pitch_deg != null ? `${image.gimbal_pitch_deg.toFixed(1)}°` : "—"} />
        <KeyValueRow label="RTK fix" value={image.rtk_fix ?? "—"} />
        <KeyValueRow label="RTK horizontal σ" value={image.rtk_std_m != null ? `${(image.rtk_std_m * 100).toFixed(1)} cm` : "—"} />
        <KeyValueRow label="NDVI mean" value={image.ndvi_mean != null ? image.ndvi_mean.toFixed(3) : "—"} />
        <KeyValueRow label="Frame key" value={image.frame_key ?? image.id} mono last />
      </Disclosure>
    </View>
  );
}
