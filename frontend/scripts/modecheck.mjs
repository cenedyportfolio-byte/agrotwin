// Headless check of the Digital Twin view modes: clicks each mode button,
// waits for tiles, screenshots, and reports the terrain in use and where each
// 3D primitive sits relative to the ground under it.
//   node scripts/modecheck.mjs <url> <outPrefix>
import puppeteer from "puppeteer-core";

const [, , url, prefix = "mode"] = process.argv;
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

for (const label of ["Field Map", "3D Twin", "Photorealistic", "Field Map"]) {
  await page.evaluate((label) => {
    const b = [...document.querySelectorAll("button")].find((el) => el.textContent?.trim().startsWith(label));
    b?.click();
  }, label);
  await new Promise((r) => setTimeout(r, 15000));
  await page.waitForFunction(() => window.__agrotwinViewer.scene.globe.tilesLoaded, { timeout: 60000, polling: 500 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 3000));
  const info = await page.evaluate(() => {
    const v = window.__agrotwinViewer, C = window.__Cesium;
    const prims = [];
    for (let i = 0; i < v.scene.primitives.length; i++) {
      const p = v.scene.primitives.get(i);
      if (!p.boundingSphere || !p.show) continue;
      const c = C.Cartographic.fromCartesian(p.boundingSphere.center);
      prims.push(`${(p.resource?.url ?? "").split("/").slice(-2, -1)[0] ?? p.constructor.name} centre ${c.height.toFixed(1)} m vs ground ${(v.scene.globe.getHeight(c) ?? NaN).toFixed(1)} m`);
    }
    const cam = v.camera.positionCartographic;
    return { terrain: v.terrainProvider.constructor.name, camAboveGround: +(cam.height - (v.scene.globe.getHeight(cam) ?? 0)).toFixed(0),
             pitch: +C.Math.toDegrees(v.camera.pitch).toFixed(0), prims };
  });
  const file = `${prefix}_${label.replace(/\s/g, "")}.png`;
  await page.screenshot({ path: file });
  console.log(`${label.padEnd(14)} terrain=${info.terrain} camera ${info.camAboveGround} m above ground, pitch ${info.pitch}° | ${info.prims.join("; ") || "no 3D primitives"}`);
}
console.log(problems.length ? "PROBLEMS:\n" + [...new Set(problems)].slice(0, 15).join("\n") : "no errors, no failed requests");
await browser.close();
