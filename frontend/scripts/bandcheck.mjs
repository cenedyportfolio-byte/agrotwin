// Headless check of the band-orthophoto layers in the Digital Twin: flies to a
// point (a GCP target by default), switches each layer on alone through the
// page's host bridge, and saves one screenshot per layer plus a contact sheet
// of them side by side, so a misaligned band shows as a shifted target.
//
//   node scripts/bandcheck.mjs <fieldId> <surveyId> <lon> <lat> [heightM=12] [outDir=bandcheck]
//
// Runs Chrome on the NVIDIA GPU (PRIME offload + ANGLE/EGL) and falls back to the
// default GPU when the NVIDIA GL stack is unusable (e.g. a driver update waiting
// for a reboot); the output names the renderer used. CHROME overrides the binary.
import puppeteer from "puppeteer-core";
import fs from "node:fs";
import path from "node:path";

const [, , fieldId, surveyId, lon, lat, height = "12", outDir = "bandcheck"] = process.argv;
if (!fieldId || !surveyId || !lon || !lat) {
  console.error("usage: node scripts/bandcheck.mjs <fieldId> <surveyId> <lon> <lat> [heightM] [outDir]");
  process.exit(2);
}
const base = process.env.AGROTWIN_WEB ?? "http://localhost:3000";
const url = `${base}/fields/${fieldId}/digital-twin?survey=${surveyId}&mode=field-map&cam=${lon},${lat},${height},0,-90`;
const LAYERS = [
  ["photo", ["orthomosaic", "gcps"]],
  ["false_color", ["falseColor", "gcps"]],
  ["alignment_check", ["alignmentCheck", "gcps"]],
  ["nir", ["bandNir", "gcps"]],
  ["red", ["bandRed", "gcps"]],
  ["ndvi", ["ndvi", "gcps"]],
];
const ALL = ["orthomosaic", "ndvi", "ndre", "gndvi", "bandGreen", "bandRed", "bandRedEdge", "bandNir", "falseColor",
  "alignmentCheck", "problemZones", "weedAreas", "rgbPoints", "fieldBoundary", "cropDensity", "vegetationMask", "gcps"];

fs.mkdirSync(outDir, { recursive: true });
const NVIDIA = {
  __NV_PRIME_RENDER_OFFLOAD: "1",
  __GLX_VENDOR_LIBRARY_NAME: "nvidia",
  __EGL_VENDOR_LIBRARY_FILENAMES: "/usr/share/glvnd/egl_vendor.d/10_nvidia.json",
};
const launch = (env) =>
  puppeteer.launch({
    executablePath: process.env.CHROME ?? "/usr/bin/google-chrome",
    headless: "new",
    env,
    args: ["--no-sandbox", "--use-gl=angle", "--use-angle=gl-egl", "--enable-gpu-rasterization", "--ignore-gpu-blocklist",
      "--window-size=1200,900", "--hide-scrollbars"],
  });
const renderer = (p) =>
  p.evaluate(() => {
    const gl = document.createElement("canvas").getContext("webgl2");
    if (!gl) return null;
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  });
let browser = await launch({ ...process.env, ...NVIDIA });
let page = await browser.newPage();
let gpuInfo = await renderer(page);
if (!gpuInfo) {
  await browser.close();
  browser = await launch(process.env);
  page = await browser.newPage();
  gpuInfo = `${await renderer(page)} (NVIDIA GL unavailable, fell back)`;
}
await page.setViewport({ width: 1200, height: 900 });
const problems = [];
const fetched = {};
page.on("pageerror", (e) => problems.push(`[pageerror] ${String(e).slice(0, 200)}`));
page.on("response", (r) => {
  const u = r.url();
  if (r.status() >= 400 && !u.includes("arcgis")) problems.push(`[${r.status()}] ${u.slice(0, 140)}`);
  const m = u.match(/\/tiles\/[^/]+\/([^/]+)\/(\d+)\//);
  if (m) fetched[`${m[1]} z${m[2]}`] = (fetched[`${m[1]} z${m[2]}`] || 0) + 1;
});
await page.goto(url, { waitUntil: "networkidle2", timeout: 120000 }).catch((e) => problems.push(`[goto] ${e.message}`));
await new Promise((r) => setTimeout(r, 12000));

const send = (msg) =>
  page.evaluate((m) => window.dispatchEvent(new CustomEvent("agrotwin:host-message", { detail: { protocol: "agrotwin-bridge/1", ...m } })), msg);
await send({ type: "SET_ADVANCED", advanced: true });

const shots = [];
for (const [name, on] of LAYERS) {
  for (const layer of ALL) await send({ type: "SET_LAYER", layer, visible: on.includes(layer) });
  await new Promise((r) => setTimeout(r, 9000));
  const file = path.join(outDir, `${name}.png`);
  await page.screenshot({ path: file, clip: { x: 300, y: 150, width: 600, height: 600 } });
  shots.push([name, file]);
}
await browser.close();
console.log(JSON.stringify({ url, gpu: gpuInfo, shots: shots.map((s) => s[1]), fetched, problems: problems.slice(0, 15) }, null, 1));
