/**
 * Message contract between the mobile app and the existing Cesium Digital
 * Twin page (frontend/app/fields/[id]/digital-twin). The web side implements
 * the same protocol in frontend/lib/hostBridge.ts.
 *
 *   Mobile → viewer : injected as a `agrotwin:host-message` CustomEvent on window
 *   Viewer → mobile : window.ReactNativeWebView.postMessage(JSON)
 *
 * Every message carries `protocol` so unrelated postMessage traffic is ignored.
 */
export const BRIDGE_PROTOCOL = "agrotwin-bridge/1";

export type TwinMode = "field-map" | "3d-twin" | "photorealistic";

/** Layer keys understood by the web viewer's digitalTwinStore. */
export type TwinLayer =
  | "fieldBoundary"
  | "mesh"
  | "orthomosaic"
  | "ndvi"
  | "problemZones"
  | "rgbPoints"
  | "cropDensity"
  | "ndre"
  | "gndvi"
  | "dsm"
  | "pointCloud"
  | "vectorOverlays";

export type HostToViewerMessage =
  | { type: "SET_LAYER"; layer: TwinLayer; visible: boolean }
  | { type: "SET_MODE"; mode: TwinMode }
  | { type: "FOCUS_ZONE"; zoneId: string }
  | { type: "SET_ADVANCED"; advanced: boolean }
  /** Fly back to the current mode's default view of the field ("Centre on field"). Older web builds ignore it. */
  | { type: "RESET_VIEW" }
  /** Look straight down at a point, e.g. where a drone photo was taken. Older web builds ignore it. */
  | { type: "FOCUS_POINT"; lat: number; lon: number }
  | { type: "PING" };

export type SplatStatus = "idle" | "loading" | "loaded" | "missing" | "error";

export type ViewerToHostMessage =
  | { type: "VIEWER_READY"; surveyId?: string | null }
  | { type: "ZONE_SELECTED"; zoneId: string | null }
  | { type: "MODE_CHANGED"; mode: TwinMode }
  | { type: "SPLAT_STATUS"; status: SplatStatus; detail?: string }
  | { type: "LAYER_ERROR"; message: string }
  | { type: "PONG" };

const VIEWER_TYPES = new Set(["VIEWER_READY", "ZONE_SELECTED", "MODE_CHANGED", "SPLAT_STATUS", "LAYER_ERROR", "PONG"]);

/** URL of the existing web viewer for a survey, in embedded mode (no site chrome, bridge enabled). */
export function buildViewerUrl(
  webBase: string,
  params: { fieldId: string; surveyId: string; mode?: TwinMode; focusZoneId?: string | null }
): string {
  const q = new URLSearchParams({ survey: params.surveyId, embed: "1" });
  if (params.mode) q.set("mode", params.mode);
  if (params.focusZoneId) q.set("zone", params.focusZoneId);
  return `${webBase.replace(/\/+$/, "")}/fields/${encodeURIComponent(params.fieldId)}/digital-twin?${q.toString()}`;
}

export function parseViewerMessage(raw: string): ViewerToHostMessage | null {
  try {
    const data = JSON.parse(raw) as { protocol?: string; type?: string };
    if (!data || data.protocol !== BRIDGE_PROTOCOL || !data.type || !VIEWER_TYPES.has(data.type)) return null;
    const { protocol: _protocol, ...message } = data;
    return message as ViewerToHostMessage;
  } catch {
    return null;
  }
}

/** JavaScript to run inside the WebView to deliver a host message. */
export function hostMessageScript(message: HostToViewerMessage): string {
  const payload = JSON.stringify({ protocol: BRIDGE_PROTOCOL, ...message });
  return `(function(){try{window.dispatchEvent(new CustomEvent('agrotwin:host-message',{detail:${payload}}));}catch(e){}})();true;`;
}

export const HIDE_WEB_CHROME_CSS = `
  .pointer-events-none.absolute.inset-x-0.top-0 { display: none !important; }
  div.pointer-events-none.absolute[class*="top-14"] { display: none !important; }
  div.pointer-events-none.absolute[class*="top-20"] { display: none !important; }
  .pointer-events-none.absolute.right-2 { display: none !important; }
  .pointer-events-none.absolute.right-4 { display: none !important; }
  .pointer-events-none.absolute.inset-x-0.bottom-0 { display: none !important; }
  div[class*="rounded-xl"]:has(button) { display: none !important; }
`;

export const injectedHideWebChromeScript = `(function(){
  try {
    var css = "${HIDE_WEB_CHROME_CSS.replace(/\n/g, " ").replace(/\s+/g, " ").trim()}";
    var style = document.getElementById('agrotwin-hide-chrome');
    if (!style) {
      style = document.createElement('style');
      style.id = 'agrotwin-hide-chrome';
      style.innerHTML = css;
      (document.head || document.documentElement).appendChild(style);
    }
    function cleanWebControls() {
      var bars = document.querySelectorAll('.pointer-events-none.absolute.inset-x-0.top-0, .pointer-events-none.absolute.inset-x-0.bottom-0');
      bars.forEach(function(el) { el.style.setProperty('display', 'none', 'important'); });
      var buttons = document.querySelectorAll('button');
      buttons.forEach(function(b) {
        var t = (b.textContent || '').trim();
        if (t.indexOf('Realistic') !== -1 || t === '3D' || t === 'Map' || t === 'Layers') {
          var bar = b.closest('.pointer-events-none') || b.closest('.pointer-events-auto') || b.parentElement;
          if (bar && bar !== document.body) bar.style.setProperty('display', 'none', 'important');
        }
      });
    }
    cleanWebControls();
    var attempts = 0;
    var timer = setInterval(function() {
      cleanWebControls();
      attempts++;
      if (attempts > 8) clearInterval(timer);
    }, 350);
  } catch (e) {}
})();true;`;

/**
 * Runs before the page's own scripts: marks the document as embedded so the
 * web page can hide its site chrome even before React hydrates, and injects
 * styles that hide standalone browser controls if the web build predates embed mode.
 */
export const injectedBeforeLoad = `(function(){
  window.__AGROTWIN_EMBED__ = true;
  try {
    document.documentElement.setAttribute('data-agrotwin-embed', '1');
    var css = "${HIDE_WEB_CHROME_CSS.replace(/\n/g, " ").replace(/\s+/g, " ").trim()}";
    var style = document.createElement('style');
    style.id = 'agrotwin-hide-chrome';
    style.innerHTML = css;
    (document.head || document.documentElement).appendChild(style);
  } catch (e) {}
})();true;`;

