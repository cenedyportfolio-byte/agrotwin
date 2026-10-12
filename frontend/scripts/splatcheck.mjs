// Headless check of Photorealistic mode: switches to it, waits for the splat
// tileset, then screenshots the default view and a few closer views.
//   node scripts/splatcheck.mjs <url> <outPrefix> <lon> <lat> [height:pitch:southOffsetDeg,...]
import puppeteer from "puppeteer-core";

const [, , url, prefix = "splat", lonS, latS, viewsS = "80:-90:0,35:-60:0.00025,15:-90:0"] = process.argv;
const [lon, lat] = [+lonS, +latS];
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  headless: "new",
  args: ["--window-size=1600,1000", "--hide-scrollbars", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000 });
const problems = [];
page.on("pageerror", (e) => problems.push(`[pageerror] ${String(e).slice(0, 200)}`));
page.on("console", (m) => { if (m.type() === "error") problems.push(`[console] ${m.text().slice(0, 200)}`); });
page.on("response", (r) => { if (r.status() >= 400) problems.push(`[${r.status()}] ${r.url().slice(0, 140)}`); });
await page.goto(url, { waitUntil: "networkidle2", timeout: 180000 });
await page.waitForFunction(() => window.__agrotwinViewer && window.__Cesium, { timeout: 120000 });
await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent?.trim().startsWith("Photorealistic"))?.click());
const loaded = await page.waitForFunction(() => {
  const v = window.__agrotwinViewer;
  for (let i = 0; i < v.scene.primitives.length; i++) {
    const p = v.scene.primitives.get(i);
    if (p.resource?.url?.includes("/splats/") && p.tilesLoaded) return true;
  }
  return false;
}, { timeout: 180000, polling: 1000 }).then(() => true).catch(() => false);
console.log(`splat tileset loaded: ${loaded}`);
await new Promise((r) => setTimeout(r, 4000));
await page.screenshot({ path: `${prefix}_default.png` });

const ground = await page.evaluate((lon, lat) => {
  const v = window.__agrotwinViewer, C = window.__Cesium;
  return v.scene.globe.getHeight(C.Cartographic.fromDegrees(lon, lat)) ?? 0;
}, lon, lat);
for (const [h, pitch, back] of viewsS.split(",").map((v) => v.split(":").map(Number))) {
  await page.evaluate((lon, lat, alt, pitch, back) => {
    const v = window.__agrotwinViewer, C = window.__Cesium;
    v.camera.setView({ destination: C.Cartesian3.fromDegrees(lon, lat - back, alt),
      orientation: { heading: 0, pitch: C.Math.toRadians(pitch), roll: 0 } });
  }, lon, lat, ground + h, pitch, back);
  await new Promise((r) => setTimeout(r, 6000));
  await page.screenshot({ path: `${prefix}_${h}m_pitch${-pitch}.png` });
  console.log(`saved ${h} m, pitch ${pitch}`);
}
// real user input: wheel-zoom in as far as the viewer allows, looking down at 60°
await page.evaluate((lon, lat, alt) => {
  const v = window.__agrotwinViewer, C = window.__Cesium;
  v.camera.setView({ destination: C.Cartesian3.fromDegrees(lon, lat - 0.0008, alt),
    orientation: { heading: 0, pitch: C.Math.toRadians(-60), roll: 0 } });
}, lon, lat, ground + 150);
await new Promise((r) => setTimeout(r, 3000));
await page.mouse.move(800, 500);
for (let i = 0; i < 60; i++) {
  await page.mouse.wheel({ deltaY: -400 });
  await new Promise((r) => setTimeout(r, 120));
}
await new Promise((r) => setTimeout(r, 5000));
const stop = await page.evaluate(() => {
  const v = window.__agrotwinViewer, C = window.__Cesium;
  const c = v.camera.positionCartographic;
  return { above: c.height - (v.scene.globe.getHeight(c) ?? 0), floor: v.scene.screenSpaceCameraController.minimumZoomDistance,
           pitch: C.Math.toDegrees(v.camera.pitch) };
});
await page.screenshot({ path: `${prefix}_wheel_limit.png` });
console.log(`wheel zoom stopped ${stop.above.toFixed(1)} m above ground at pitch ${stop.pitch.toFixed(0)}° (zoom floor ${stop.floor.toFixed(1)} m)`);
console.log(problems.length ? "PROBLEMS:\n" + [...new Set(problems)].slice(0, 15).join("\n") : "no errors, no failed requests");
await browser.close();
