import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, type ReactNode } from "react";
import { Platform, StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import MapView, { PROVIDER_DEFAULT, PROVIDER_GOOGLE, type Region } from "react-native-maps";
import type { Geometry } from "geojson";
import { useMapLayerStore } from "@/stores/mapLayerStore";
import type { DetectionZone, SurveyAsset, SurveyImage } from "@/types";
import { bboxFromPoints, bboxOf, bboxUnion, regionFromBBox, type BBox, type LatLng } from "@/utils/geo";
import { DetectionZoneLayer } from "./DetectionZoneLayer";
import { FieldBoundaryLayer } from "./FieldBoundaryLayer";
import { OrthomosaicLayer } from "./OrthomosaicLayer";
import { SurveyImageLayer } from "./SurveyImageLayer";
import { selectRasterSources } from "./mapLayers";

export interface MapViewerHandle {
  fitToField: (animated?: boolean) => void;
  focusOn: (bbox: BBox | LatLng, animated?: boolean) => void;
}

interface MapViewerProps {
  boundary: Geometry | null | undefined;
  zones: DetectionZone[];
  images: SurveyImage[];
  assets: SurveyAsset[] | undefined;
  selectedZoneId?: string | null;
  onSelectZone?: (zone: DetectionZone | null) => void;
  highlightImageId?: string | null;
  showsUserLocation?: boolean;
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
  onMapReady?: () => void;
  /**
   * Android only. Fired when the Google Maps SDK has not drawn a single base
   * tile within a few seconds of the map being ready — the signature of a
   * build without a Maps API key or a device without Google Play services.
   * The screen can then explain the blank beige canvas instead of leaving
   * the farmer staring at it (the field data itself has already loaded).
   */
  onBaseMapStalled?: () => void;
  /** Fired once the base tiles have rendered (clears a stalled notice). */
  onBaseMapLoaded?: () => void;
  /** Padding (px) kept clear of overlays when fitting. */
  edgePadding?: { top: number; right: number; bottom: number; left: number };
}

/** How long after onMapReady to wait for the first onMapLoaded before reporting a stalled base map. */
const BASE_MAP_STALL_MS = 8_000;

/**
 * The one component that knows about react-native-maps. Screens compose
 * layers through props and drive the camera via the imperative handle.
 */
export const MapViewer = forwardRef<MapViewerHandle, MapViewerProps>(function MapViewer(
  { boundary, zones, images, assets, selectedZoneId, onSelectZone, highlightImageId, showsUserLocation, style, children, onMapReady, onBaseMapStalled, onBaseMapLoaded, edgePadding },
  ref
) {
  const mapRef = useRef<MapView>(null);
  const stallTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const baseLoaded = useRef(false);
  useEffect(
    () => () => {
      if (stallTimer.current) clearTimeout(stallTimer.current);
    },
    []
  );
  const armStallTimer = useCallback(() => {
    if (Platform.OS !== "android" || baseLoaded.current || stallTimer.current) return;
    stallTimer.current = setTimeout(() => {
      stallTimer.current = null;
      if (!baseLoaded.current) onBaseMapStalled?.();
    }, BASE_MAP_STALL_MS);
  }, [onBaseMapStalled]);
  const handleMapLoaded = useCallback(() => {
    baseLoaded.current = true;
    if (stallTimer.current) {
      clearTimeout(stallTimer.current);
      stallTimer.current = null;
    }
    onBaseMapLoaded?.();
  }, [onBaseMapLoaded]);
  const layers = useMapLayerStore((s) => s.layers);
  const baseLayer = useMapLayerStore((s) => s.baseLayer);
  const rasters = useMemo(() => selectRasterSources(assets), [assets]);

  const fieldBBox = useMemo<BBox | null>(() => {
    let b = bboxOf(boundary);
    if (!b) {
      for (const z of zones) b = bboxUnion(b, bboxOf(z.geometry));
    }
    if (!b) {
      const pts = images.filter((i) => i.lat != null && i.lon != null).map((i) => ({ latitude: i.lat as number, longitude: i.lon as number }));
      b = bboxFromPoints(pts);
    }
    if (!b && rasters.orthomosaic) b = rasters.orthomosaic.bounds;
    return b;
  }, [boundary, zones, images, rasters.orthomosaic]);

  const initialRegion = useMemo<Region | undefined>(() => (fieldBBox ? regionFromBBox(fieldBBox) : undefined), [fieldBBox]);

  const fitToField = useCallback(
    (animated = true) => {
      if (!fieldBBox || !mapRef.current) return;
      mapRef.current.fitToCoordinates(
        [
          { latitude: fieldBBox.south, longitude: fieldBBox.west },
          { latitude: fieldBBox.north, longitude: fieldBBox.east },
        ],
        { edgePadding: edgePadding ?? { top: 80, right: 40, bottom: 120, left: 40 }, animated }
      );
    },
    [fieldBBox, edgePadding]
  );

  const focusOn = useCallback(
    (target: BBox | LatLng, animated = true) => {
      if (!mapRef.current) return;
      if ("west" in target) {
        mapRef.current.fitToCoordinates(
          [
            { latitude: target.south, longitude: target.west },
            { latitude: target.north, longitude: target.east },
          ],
          { edgePadding: { top: 120, right: 80, bottom: 260, left: 80 }, animated }
        );
      } else {
        mapRef.current.animateToRegion({ ...target, latitudeDelta: 0.0012, longitudeDelta: 0.0012 }, animated ? 500 : 0);
      }
    },
    []
  );

  useImperativeHandle(ref, () => ({ fitToField, focusOn }), [fitToField, focusOn]);

  return (
    <MapView
      ref={mapRef}
      // Google Maps on Android (built into Expo Go); Apple Maps on iOS needs no key or SDK setup.
      provider={Platform.OS === "android" ? PROVIDER_GOOGLE : PROVIDER_DEFAULT}
      style={[styles.map, style]}
      mapType={baseLayer}
      initialRegion={initialRegion}
      onMapReady={() => {
        fitToField(false);
        armStallTimer();
        onMapReady?.();
      }}
      onMapLoaded={handleMapLoaded}
      onPress={() => onSelectZone?.(null)}
      showsUserLocation={showsUserLocation}
      showsMyLocationButton={false}
      showsCompass
      toolbarEnabled={false}
      pitchEnabled={false}
      loadingEnabled
      accessibilityLabel="Field map"
    >
      <OrthomosaicLayer source={rasters.orthomosaic} visible={layers.orthomosaic} zIndex={1} />
      <OrthomosaicLayer source={rasters.ndvi} visible={layers.ndvi} zIndex={2} opacity={0.85} />
      <OrthomosaicLayer source={rasters.ndre} visible={layers.ndre} zIndex={2} opacity={0.85} />
      <OrthomosaicLayer source={rasters.gndvi} visible={layers.gndvi} zIndex={2} opacity={0.85} />
      <OrthomosaicLayer source={rasters.dsm} visible={layers.dsm} zIndex={2} opacity={0.7} />
      <FieldBoundaryLayer boundary={boundary} visible={layers.field} />
      <SurveyImageLayer images={images} visible={layers.imagePoints || !!highlightImageId} highlightId={highlightImageId} />
      <DetectionZoneLayer zones={zones} visible={layers.zones} selectedId={selectedZoneId} onSelect={(z) => onSelectZone?.(z)} />
      {children}
    </MapView>
  );
});

const styles = StyleSheet.create({ map: { flex: 1 } });
