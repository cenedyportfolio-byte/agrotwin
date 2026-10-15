"use client";

import { useEffect } from "react";
import { useSearchParams } from "next/navigation";
import type { LayerKey, ViewMode } from "@/lib/digitalTwinStore";

/**
 * Optional bridge to a native host (the AgroTwin Expo app shows this page in
 * a WebView). Everything here is a no-op in a normal browser tab.
 *
 *   Host → page : `agrotwin:host-message` CustomEvent on window
 *   Page → host : window.ReactNativeWebView.postMessage(JSON)
 *
 * The mobile side of the contract lives in
 * mobile/components/digitalTwin/digitalTwinBridge.ts — keep the two in sync.
 */
export const BRIDGE_PROTOCOL = "agrotwin-bridge/1";

export type HostMessage =
  | { type: "SET_LAYER"; layer: LayerKey; visible: boolean }
  | { type: "SET_MODE"; mode: ViewMode }
  | { type: "FOCUS_ZONE"; zoneId: string }
  | { type: "SET_ADVANCED"; advanced: boolean }
  /** Fly back to this mode's view of the field (the app's "Centre" button). */
  | { type: "RESET_VIEW" }
  /** Look straight down at a point, e.g. where a drone photo was taken. */
  | { type: "FOCUS_POINT"; lat: number; lon: number }
  /** The app closed its zone / target sheet: drop the highlight. */
  | { type: "CLEAR_SELECTION" }
  | { type: "PING" };

/** A tapped ground control target, for the app's own sheet (the page's panel
 * would sit under the app's buttons). */
export interface HostGcp {
  id: string;
  name: string;
  lat: number;
  lon: number;
  height_m: number | null;
  size_m: number | null;
  source: string;
  rtk: boolean;
}

export type PageMessage =
  | { type: "VIEWER_READY"; surveyId?: string | null }
  | { type: "ZONE_SELECTED"; zoneId: string | null }
  | { type: "MODE_CHANGED"; mode: ViewMode }
  | { type: "SPLAT_STATUS"; status: string; detail?: string }
  | { type: "LAYER_ERROR"; message: string }
  | { type: "GCP_SELECTED"; gcp: HostGcp | null }
  | { type: "PONG" };

interface HostWindow extends Window {
  ReactNativeWebView?: { postMessage: (data: string) => void };
  __AGROTWIN_EMBED__?: boolean;
}

function hostWindow(): HostWindow | null {
  return typeof window === "undefined" ? null : (window as HostWindow);
}

/** True when running inside the mobile app's WebView (or with ?embed=1 for testing in a browser). */
export function useIsEmbedded(): boolean {
  const params = useSearchParams();
  const w = hostWindow();
  return params.get("embed") === "1" || !!w?.__AGROTWIN_EMBED__ || !!w?.ReactNativeWebView;
}

/** Sends a message to the host app. Silently does nothing outside the WebView. */
export function notifyHost(message: PageMessage): void {
  const w = hostWindow();
  if (!w?.ReactNativeWebView) return;
  try {
    w.ReactNativeWebView.postMessage(JSON.stringify({ protocol: BRIDGE_PROTOCOL, ...message }));
  } catch {
    // never let host messaging break the viewer
  }
}

interface HostBridgeHandlers {
  onSetLayer?: (layer: LayerKey, visible: boolean) => void;
  onSetMode?: (mode: ViewMode) => void;
  onFocusZone?: (zoneId: string) => void;
  onSetAdvanced?: (advanced: boolean) => void;
  onResetView?: () => void;
  onFocusPoint?: (lat: number, lon: number) => void;
  onClearSelection?: () => void;
}

/** Subscribes to host messages for the lifetime of the component. */
export function useHostBridge(handlers: HostBridgeHandlers): void {
  useEffect(() => {
    const w = hostWindow();
    if (!w) return;
    const listener = (evt: Event) => {
      const detail = (evt as CustomEvent<{ protocol?: string } & HostMessage>).detail;
      if (!detail || detail.protocol !== BRIDGE_PROTOCOL) return;
      switch (detail.type) {
        case "SET_LAYER":
          handlers.onSetLayer?.(detail.layer, detail.visible);
          break;
        case "SET_MODE":
          handlers.onSetMode?.(detail.mode);
          break;
        case "FOCUS_ZONE":
          handlers.onFocusZone?.(detail.zoneId);
          break;
        case "SET_ADVANCED":
          handlers.onSetAdvanced?.(detail.advanced);
          break;
        case "RESET_VIEW":
          handlers.onResetView?.();
          break;
        case "FOCUS_POINT":
          handlers.onFocusPoint?.(detail.lat, detail.lon);
          break;
        case "CLEAR_SELECTION":
          handlers.onClearSelection?.();
          break;
        case "PING":
          notifyHost({ type: "PONG" });
          break;
      }
    };
    w.addEventListener("agrotwin:host-message", listener);
    return () => w.removeEventListener("agrotwin:host-message", listener);
  }, [handlers]);
}
