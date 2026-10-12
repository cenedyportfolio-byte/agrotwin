// Headless zoom check of the Digital Twin Field Map: looks straight down at one
// ground point from a series of heights, screenshots each, and reports which
// tile zoom levels were fetched and any failed requests.
//   node scripts/zoomcheck.mjs <url> <outPrefix> <lon> <lat> [heights_m,...]
import puppeteer from "puppeteer-core";

const [, , url, prefix = "zoom", lonS, latS, heightsS = "200,50,15,8,3"] = process.argv;
const lon = +lonS, lat = +latS;
const heights = heightsS.split(",").map(Number);
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  headless: "new",
  args: ["--window-size=1600,1000", "--hide-scrollbars", "--ignore-gpu-blocklist", "--enable-gpu-rasterization"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000 });
const problems = [];
let zooms = {};
page.on("pageerror", (e) => problems.push(`[pageerror] ${String(e).slice(0, 200)}`));
page.on("console", (m) => { if (m.type() === "error") problems.push(`[console] ${m.text().slice(0, 200)}`); });
page.on("response", (r) => {
  const u = r.url();
  if (r.status() >= 400) problems.push(`[${r.status()}] ${u.slice(0, 140)}`);
  const m = u.match(/\/tiles\/[^/]+\/([^/]+)\/(\d+)\//);
  if (m) zooms[`${m[1]} z${m[2]}`] = (zooms[`${m[1]} z${m[2]}`] || 0) + 1;
});
await page.goto(url, { waitUntil: "networkidle2", timeout: 180000 }).catch((e) => problems.push(`[goto] ${e.message}`));
await page.waitForFunction(() => window.__agrotwinViewer && window.__Cesium, { timeout: 120000 });
await new Promise((r) => setTimeout(r, 8000));

const ground = await page.evaluate((lon, lat) => {
  const v = window.__agrotwinViewer, C = window.__Cesium;
  return v.scene.globe.getHeight(C.Cartographic.fromDegrees(lon, lat)) ?? 0;
}, lon, lat);
console.log(`ground height at target: ${ground.toFixed(1)} m`);

for (const h of heights) {
  zooms = {};
  await page.evaluate((lon, lat, alt) => {
    const v = window.__agrotwinViewer, C = window.__Cesium;
    v.camera.setView({ destination: C.Cartesian3.fromDegrees(lon, lat, alt),
      orientation: { heading: 0, pitch: C.Math.toRadians(-90), roll: 0 } });
  }, lon, lat, ground + h);
  // wait until the globe reports every visible tile loaded (max 60 s)
  const t0 = Date.now();
  await page.waitForFunction(() => window.__agrotwinViewer.scene.globe.tilesLoaded, { timeout: 60000, polling: 500 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 2500));
  const fov = await page.evaluate(() => window.__agrotwinViewer.camera.frustum.fov);
  const cmPerScreenPx = (2 * h * Math.tan(fov / 2) / 1600) * 100;
  await page.screenshot({ path: `${prefix}_${h}m.png` });
  console.log(`${h} m: ${cmPerScreenPx.toFixed(2)} cm of ground per screen pixel | loaded in ${((Date.now() - t0) / 1000).toFixed(1)} s | tiles: ${JSON.stringify(zooms)}`);
}
// real user input: wheel-zoom in from 50 m as far as the viewer allows
await page.evaluate((lon, lat, alt) => {
  const v = window.__agrotwinViewer, C = window.__Cesium;
  v.camera.setView({ destination: C.Cartesian3.fromDegrees(lon, lat, alt),
    orientation: { heading: 0, pitch: C.Math.toRadians(-90), roll: 0 } });
}, lon, lat, ground + 50);
await new Promise((r) => setTimeout(r, 3000));
await page.mouse.move(800, 500);
for (let i = 0; i < 60; i++) {
  await page.mouse.wheel({ deltaY: -400 });
  await new Promise((r) => setTimeout(r, 120));
}
await page.waitForFunction(() => window.__agrotwinViewer.scene.globe.tilesLoaded, { timeout: 60000, polling: 500 }).catch(() => {});
await new Promise((r) => setTimeout(r, 2500));
const stop = await page.evaluate(() => {
  const v = window.__agrotwinViewer;
  const c = v.camera.positionCartographic;
  return { above: c.height - (v.scene.globe.getHeight(c) ?? 0), floor: v.scene.screenSpaceCameraController.minimumZoomDistance };
});
await page.screenshot({ path: `${prefix}_wheel_limit.png` });
console.log(`wheel zoom stopped ${stop.above.toFixed(1)} m above ground (zoom floor ${stop.floor.toFixed(1)} m)`);
console.log(problems.length ? "PROBLEMS:\n" + [...new Set(problems)].slice(0, 20).join("\n") : "no errors, no failed requests");
await browser.close();
