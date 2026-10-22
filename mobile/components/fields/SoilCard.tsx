import { StyleSheet, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import type { Geometry } from "geojson";
import { Layers } from "lucide-react-native";
import { iconStroke } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import { useSoil } from "@/features/fields/hooks";
import type { DetectionZone, FieldSummary, SoilUnit } from "@/types";
import { formatAcres } from "@/utils/format";
import { boundsOf, fit } from "@/utils/geoSvg";
import { AppText, Blueprint, LoadingState } from "@/components/ui";

/** One colour per soil, in the order of their share of the field (as on the website). */
export const SOIL_COLORS = ["#a07850", "#7c9a5c", "#c8a45a", "#6f8fae", "#b8735c", "#8d7aa8", "#5f9488", "#c4927a", "#8a8a5c", "#a4a4a4"];

function details(u: SoilUnit): string {
  return [
    u.drainage,
    u.texture,
    u.organic_matter_pct != null ? `organic matter ${u.organic_matter_pct}%` : null,
    u.ph != null ? `pH ${u.ph}` : null,
    u.slope_pct != null ? `${u.slope_pct}% slope` : null,
    u.flooding && u.flooding !== "None" ? `${u.flooding.toLowerCase()} flooding` : null,
    u.water_table_cm != null ? `water table from ${Math.round(u.water_table_cm / 2.54)} in` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The soil under the field (USDA soil survey): its soils on a small map with
 * the field's edge, each soil's share and surface layer, and how many of the
 * latest flight's spots lie on it — where they lie, never why. */
export function SoilCard({ field, detections }: { field: FieldSummary; detections?: DetectionZone[] }) {
  const { colors } = useTheme();
  const { data } = useSoil(field);
  if (!data || data.status === "no_outline" || data.status === "off") return null;

  const head = (
    <View style={styles.head}>
      <Layers size={18} color={colors.accent} strokeWidth={iconStroke} />
      <AppText variant="heading" style={{ flex: 1 }}>
        Soil
      </AppText>
      <AppText variant="caption" tone="muted">
        USDA soil survey
      </AppText>
    </View>
  );
  if (data.status !== "ok" || !data.units?.length) {
    return (
      <Blueprint style={{ gap: 8 }}>
        {head}
        {data.status === "fetching" ? (
          <LoadingState message="Looking up the soil survey for this field…" />
        ) : (
          <AppText variant="bodySm" tone="muted">
            {data.status === "none"
              ? "No soil survey covers this field (the USDA survey is for US fields)."
              : "The USDA soil service could not be reached; AgroTwin tries again later."}
          </AppText>
        )}
      </Blueprint>
    );
  }

  const units = data.units;
  const color = Object.fromEntries(units.map((u, i) => [u.mukey, SOIL_COLORS[i % SOIL_COLORS.length] ?? "#a4a4a4"]));
  const outline: Geometry | null = field.boundary_geojson ? (JSON.parse(field.boundary_geojson) as Geometry) : null;
  const shapes = data.geojson?.features ?? [];
  const bounds = boundsOf([...(outline ? [outline] : []), ...shapes.map((f) => f.geometry)]);
  const map = bounds ? fit(bounds, 320) : null;
  const onSoil = new Map(Object.entries(data.spots_by_soil ?? {}));

  return (
    <Blueprint style={{ gap: 12 }}>
      {head}
      {map ? (
        <Svg width="100%" height={Math.min(map.height, 260)} viewBox={`0 0 320 ${map.height}`} accessibilityLabel="Soil map of the field">
          {shapes.map((f) => (
            <Path key={f.properties.mukey} d={map.path(f.geometry)} fill={color[f.properties.mukey]} fillOpacity={0.75} stroke={colors.bg} strokeWidth={0.6} />
          ))}
          {detections?.map((d) => <Path key={d.id} d={map.path(d.geometry)} fill="none" stroke={colors.text} strokeWidth={1.2} />)}
          {outline ? <Path d={map.path(outline)} fill="none" stroke={colors.text} strokeWidth={1.6} strokeDasharray="4 3" /> : null}
        </Svg>
      ) : null}
      <View style={{ gap: 10 }}>
        {units.map((u) => {
          const spots = onSoil.get(u.mukey);
          return (
            <View key={u.mukey} style={styles.unit}>
              <View style={[styles.swatch, { backgroundColor: color[u.mukey] }]} />
              <View style={{ flex: 1, gap: 2 }}>
                <AppText variant="bodySmStrong">
                  {u.symbol ? `${u.symbol} · ` : ""}
                  {u.name}
                </AppText>
                <AppText variant="small" tone="muted">
                  {Math.round(u.share)}% of the field · {formatAcres(u.acres)}
                </AppText>
                <AppText variant="small" tone="muted">
                  {details(u)}
                </AppText>
                {spots ? (
                  <AppText variant="small">
                    {spots.count} {spots.count === 1 ? "spot" : "spots"} of the latest flight on this soil ({formatAcres(spots.acres)})
                  </AppText>
                ) : null}
              </View>
            </View>
          );
        })}
      </View>
      <AppText variant="small" tone="muted">
        {detections?.length ? "Outlined: the latest flight's spots. " : ""}The soil survey maps soils to about an acre: it shows where a spot lies, not why. Talk it over with your agronomist before acting on it.
      </AppText>
    </Blueprint>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: "row", alignItems: "center", gap: 8 },
  unit: { flexDirection: "row", gap: 8 },
  swatch: { width: 12, height: 12, borderRadius: 2, marginTop: 4 },
});
