// Finds what draws a thin dark seam line in the Field Map: renders the same
// straight-down view with the terrain / survey imagery toggled and measures
// saves each view (one per camera pitch) for row-darkness analysis.
//   node scripts/seamcheck.mjs <url> <outPrefix> <lon> <lat> <height_m>
import puppeteer from "puppeteer-core";

const [, , url, prefix, lonS, latS, hS, pitchesS = "-90"] = process.argv;
const [lon, lat, h] = [+lonS, +latS, +hS];
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  headless: "new",
  args: ["--window-size=1600,1000", "--hide-scrollbars", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000 });
await page.goto(url, { waitUntil: "networkidle2", timeout: 180000 });
await page.waitForFunction(() => window.__agrotwinViewer && window.__Cesium, { timeout: 120000 });
await new Promise((r) => setTimeout(r, 8000));

async function shot(label, setup, pitch = -90) {
  await page.evaluate(setup);
  await page.evaluate((lon, lat, h, pitch) => {
    const v = window.__agrotwinViewer, C = window.__Cesium;
    const g = v.scene.globe.getHeight(C.Cartographic.fromDegrees(lon, lat)) ?? 0;
    v.camera.setView({ destination: C.Cartesian3.fromDegrees(lon, lat, g + h),
      orientation: { heading: 0, pitch: C.Math.toRadians(pitch), roll: 0 } });
  }, lon, lat, h, pitch);
  await page.waitForFunction(() => window.__agrotwinViewer.scene.globe.tilesLoaded, { timeout: 60000, polling: 500 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 3000));
  await page.screenshot({ path: `${prefix}_${label}.png`, clip: { x: 0, y: 60, width: 1300, height: 880 } });
  console.log(`saved ${label}`);
}

for (const p of pitchesS.split(",").map(Number)) await shot(`pitch${-p}`, () => {}, p);
await browser.close();
