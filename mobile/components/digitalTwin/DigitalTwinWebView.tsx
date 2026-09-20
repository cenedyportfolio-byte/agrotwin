import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { immersive } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import { ApiError } from "@/services/errors";
import { getWebViewerUrl } from "@/services/runtimeConfig";
import { ErrorState, AppText } from "@/components/ui";
import {
  buildViewerUrl,
  hostMessageScript,
  injectedBeforeLoad,
  injectedHideWebChromeScript,
  parseViewerMessage,
  type HostToViewerMessage,
  type SplatStatus,
  type TwinMode,
  type ViewerToHostMessage,
} from "./digitalTwinBridge";

export interface DigitalTwinHandle {
  send: (message: HostToViewerMessage) => void;
  reload: () => void;
}

interface DigitalTwinWebViewProps {
  fieldId: string;
  surveyId: string;
  mode?: TwinMode;
  focusZoneId?: string | null;
  onReady?: () => void;
  onZoneSelected?: (zoneId: string | null) => void;
  onModeChanged?: (mode: TwinMode) => void;
  onSplatStatus?: (status: SplatStatus, detail?: string) => void;
  onLayerError?: (message: string) => void;
  /** Colour of the safe-area strips above and below the page (defaults to the immersive dark ground). */
  frameColor?: string;
}

/** How long to wait for VIEWER_READY before assuming the page loaded without the bridge. */
const READY_FALLBACK_MS = 25_000;

/**
 * Hosts the existing CesiumJS Digital Twin (the Next.js page) in a WebView.
 * The only component in the app that knows about react-native-webview.
 */
export const DigitalTwinWebView = forwardRef<DigitalTwinHandle, DigitalTwinWebViewProps>(function DigitalTwinWebView(
  { fieldId, surveyId, mode, focusZoneId, onReady, onZoneSelected, onModeChanged, onSplatStatus, onLayerError, frameColor = immersive.bg },
  ref
) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  // The WebView is laid out edge-to-edge, and an Android WebView reports no
  // safe-area insets to the page, so the site's own chrome (mode chips, health
  // strip) would sit under the status bar and the gesture bar. Inset the page
  // here instead; the native overlays the screens draw already use the insets.
  const frame = { paddingTop: insets.top, paddingBottom: insets.bottom, backgroundColor: frameColor };
  const webRef = useRef<WebView>(null);
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(true);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const webBase = getWebViewerUrl();
  const url = useMemo(
    () => (webBase ? buildViewerUrl(webBase, { fieldId, surveyId, mode, focusZoneId }) : null),
    [webBase, fieldId, surveyId, mode, focusZoneId]
  );

  const send = useCallback((message: HostToViewerMessage) => {
    webRef.current?.injectJavaScript(hostMessageScript(message));
  }, []);

  const reload = useCallback(() => {
    setError(null);
    setLoading(true);
    setReady(false);
    setAttempt((n) => n + 1);
  }, []);

  useImperativeHandle(ref, () => ({ send, reload }), [send, reload]);

  // Re-apply the requested focus when it changes after the viewer is ready.
  useEffect(() => {
    if (ready && focusZoneId) send({ type: "FOCUS_ZONE", zoneId: focusZoneId });
  }, [ready, focusZoneId, send]);

  useEffect(() => {
    if (!loading) return;
    const t = setTimeout(() => setLoading(false), READY_FALLBACK_MS);
    return () => clearTimeout(t);
  }, [loading, attempt]);

  const handleMessage = useCallback(
    (evt: WebViewMessageEvent) => {
      const message: ViewerToHostMessage | null = parseViewerMessage(evt.nativeEvent.data);
      if (!message) return;
      switch (message.type) {
        case "VIEWER_READY":
          setReady(true);
          setLoading(false);
          onReady?.();
          break;
        case "ZONE_SELECTED":
          onZoneSelected?.(message.zoneId);
          break;
        case "MODE_CHANGED":
          onModeChanged?.(message.mode);
          break;
        case "SPLAT_STATUS":
          onSplatStatus?.(message.status, message.detail);
          break;
        case "LAYER_ERROR":
          onLayerError?.(message.message);
          break;
        case "PONG":
          break;
      }
    },
    [onReady, onZoneSelected, onModeChanged, onSplatStatus, onLayerError]
  );

  if (!url) {
    return (
      <View style={[styles.fill, frame, { backgroundColor: colors.bg }]}>
        <ErrorState error={new ApiError("not_configured", "Web viewer address not configured")} title="Web viewer address not set" />
      </View>
    );
  }

  if (error) {
    return (
      <View style={[styles.fill, frame, { backgroundColor: colors.bg }]}>
        <ErrorState error={error} onRetry={reload} title="Digital twin unavailable" />
        <AppText variant="caption" tone="muted" style={styles.hint} selectable>
          {url}
        </AppText>
      </View>
    );
  }

  return (
    <View style={[styles.fill, frame]}>
      <WebView
        key={attempt}
        ref={webRef}
        source={{ uri: url }}
        style={[styles.fill, { backgroundColor: immersive.bg }]}
        originWhitelist={["http://*", "https://*"]}
        injectedJavaScriptBeforeContentLoaded={injectedBeforeLoad}
        onMessage={handleMessage}
        onLoadEnd={() => {
          webRef.current?.injectJavaScript(injectedHideWebChromeScript);
          // Bridge-less page (older web build): hide the spinner once the document loaded.
          setTimeout(() => setLoading(false), 1500);
        }}
        onError={(e) => setError(new ApiError("offline", e.nativeEvent.description || "The web app could not be reached"))}
        onHttpError={(e) =>
          setError(new ApiError("http", `The web app answered ${e.nativeEvent.statusCode}`, { status: e.nativeEvent.statusCode, path: url }))
        }
        onRenderProcessGone={() => setError(new ApiError("parse", "The 3D viewer ran out of memory and was closed by Android. Try again with fewer layers."))}
        javaScriptEnabled
        domStorageEnabled
        allowsInlineMediaPlayback
        mixedContentMode="always"
        setSupportMultipleWindows={false}
        androidLayerType="hardware"
        allowsBackForwardNavigationGestures={false}
        webviewDebuggingEnabled={__DEV__}
        accessibilityLabel="Digital Twin 3D viewer"
      />
      {loading ? (
        <View style={[styles.overlay, { backgroundColor: immersive.bg }]} accessibilityRole="progressbar" accessibilityLabel="Loading digital twin">
          <ActivityIndicator size="large" color={colors.accent} />
          <AppText variant="tagUpper" tone="inverseMuted" style={{ letterSpacing: 1.8 }}>
            3D viewer loading
          </AppText>
          <AppText variant="small" style={[styles.hint, { color: immersive.textFaint }]}>
            Cesium scene renders here — streamed from your AgroTwin computer.
          </AppText>
        </View>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  fill: { flex: 1 },
  overlay: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center", gap: 12, padding: 24 },
  hint: { textAlign: "center", paddingHorizontal: 40 },
});
