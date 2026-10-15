"use client";

import Link from "next/link";
import { useState } from "react";
import { Brand, CHECK, Corners, IC, Icon, ThemeScript, ThemeSwitch, useSiteTheme } from "./parts";
import s from "./landing.module.css";

/* The public landing page (the site's front door for visitors, and /welcome),
   from the Claude Design handoff "AgroTwin Landing". Content and figures are
   the design's own. */

type ModeKey = "rgb" | "ndvi" | "nir" | "splat";

const FILE = ["M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z", "M14 2v4a2 2 0 0 0 2 2h4"];

const NAV = [
  ["Technology", "#engine"],
  ["Two-Stage Engine", "#engine"],
  ["Multispectral & CV", "#multispectral"],
  ["Field AI", "#ai"],
  ["Mobile App", "#mobile"],
] as const;

const MODES: { k: ModeKey; label: string; alt: string; legendLabel: string; ramp: string; lo: string; hi: string }[] = [
  { k: "rgb", label: "Natural RGB", alt: "Natural-colour orthophoto of the soybean field", legendLabel: "RGB ORTHO · 0.75 cm/px", ramp: "linear-gradient(90deg,#5a4a33,#6f7a45,#9aa86a)", lo: "soil", hi: "canopy" },
  { k: "ndvi", label: "Calibrated NDVI", alt: "Calibrated NDVI crop-health map of the field", legendLabel: "NDVI", ramp: "linear-gradient(90deg,#ef4444,#eab308,#22c55e)", lo: "0.20", hi: "0.90" },
  { k: "nir", label: "False-Color NIR·R·G", alt: "False-colour near-infrared composite of the field", legendLabel: "NIR · R · G", ramp: "linear-gradient(90deg,#3b5d7a,#a0525e,#e0353f)", lo: "low NIR", hi: "high NIR" },
  { k: "splat", label: "3D Gaussian Splat", alt: "3D Gaussian splat reconstruction of the field", legendLabel: "DSM ELEVATION (m)", ramp: "linear-gradient(90deg,#1e3a5f,#5c8a6a,#d9d2a0)", lo: "214.2", hi: "219.8" },
];

const HEALTH = [
  { label: "Healthy", pct: "49.9%", color: "var(--ok)", icon: IC.ok },
  { label: "Attention", pct: "44.4%", color: "var(--warn)", icon: IC.warn },
  { label: "Problem", pct: "5.6%", color: "var(--bad)", icon: IC.bad },
];

const METRICS = [
  { tag: "QUICK MOSAIC", value: "93 s", desc: "GPU-accelerated direct georeferencing and RGB quick mosaic for 1,378 frames." },
  { tag: "GROUND SAMPLE DISTANCE", value: "0.75 cm/px", desc: "Native camera resolution with zero draft downsampling or blur." },
  { tag: "GCP ALIGNMENT", value: "< 1.4 cm", desc: "Median ground target alignment to physical RTK checkerboard markers." },
];

const STAGES = [
  {
    where: "STAGE 1 · IN THE FIELD",
    badge: "Ready in 90 Seconds",
    title: "The Quick Map",
    best: "Immediate in-field scouting before leaving the farm.",
    desc: "Direct georeferencing on GPU from RTK EXIF, gimbal attitude and lens dewarp data. Generates instant XYZ tile pyramids and ExG biomass maps at the tailgate of the truck.",
    steps: ["RTK EXIF", "Gimbal attitude", "Lens dewarp", "XYZ tiles", "ExG biomass"],
  },
  {
    where: "STAGE 2 · OVERNIGHT LAB",
    badge: "Sub-Centimeter Photogrammetry",
    title: "The Definitive Twin",
    best: "Multi-season digital archiving and survey-grade GIS analysis.",
    desc: "OpenDroneMap bundle adjustment in Docker. Graph-cut seamline optimization, dense SfM point cloud, DSM elevation modeling and millimeter band co-registration.",
    steps: ["Bundle adjustment", "Graph-cut seamlines", "Dense SfM", "DSM", "Band co-registration"],
  },
];

const INDICES = ["NDVI", "NDRE", "GNDVI"];
const BANDS = [
  { name: "Green", nm: "560 nm", swatch: "#4ade80" },
  { name: "Red", nm: "650 nm", swatch: "#ef4444" },
  { name: "Red Edge", nm: "730 nm", swatch: "#b91c1c" },
  { name: "NIR", nm: "860 nm", swatch: "#a8a29e" },
];
const SOURCES = ["backend/app/knowledge/soybean_growth_stages.md", "survey_ditty_road_qa.json"];

const LAYERS = ["DSM", "Splats", "NDVI", "Points", "GCP pins"] as const;
type Layer = (typeof LAYERS)[number];

const SPOTS = [
  { name: "South boundary", word: "Problem", color: "var(--bad)", icon: IC.bad, dist: "210 m" },
  { name: "Wet corner, SE", word: "Attention", color: "var(--warn)", icon: IC.warn, dist: "340 m" },
  { name: "Headland, west", word: "Attention", color: "var(--warn)", icon: IC.warn, dist: "480 m" },
];

function SignInButton() {
  return (
    <Link href="/login" className={`${s.btn} ${s.cta} ${s.blueprint}`}>
      <Corners />
      Sign In→
    </Link>
  );
}

export function Landing({ fontClassName }: { fontClassName: string }) {
  const { mode: themeMode, theme } = useSiteTheme();

  const [mode, setMode] = useState<ModeKey>("ndvi");
  const activeMode = MODES.find((m) => m.k === mode) ?? MODES[1];
  const [layers, setLayers] = useState<Record<Layer, boolean>>({ DSM: true, Splats: true, NDVI: false, Points: false, "GCP pins": true });
  const layersOn = LAYERS.filter((k) => layers[k]);

  return (
    <div className={`${s.root} ${fontClassName}`} data-theme={theme} suppressHydrationWarning>
      <ThemeScript />

      <header className={s.header}>
        <div className={s.headerInner}>
          <Brand href="#top" />

          <nav className={s.nav} aria-label="Sections">
            {NAV.map(([label, href]) => (
              <a key={label} href={href} className={s.navLink}>
                {label}
              </a>
            ))}
          </nav>

          <div className={s.actions}>
            <ThemeSwitch mode={themeMode} />
            <Link href="/login" className={`${s.btn} ${s.btnGhost} ${s.signIn}`}>
              Sign In
            </Link>
          </div>
        </div>
      </header>

      <section id="hero" className={`${s.section} ${s.hero}`}>
        <div aria-hidden="true" className={s.contours} />
        <div className={s.heroInner}>
          <div className={s.heroCopy}>
            <span className={s.badge}>PRECISION DIGITAL TWIN • DJI MAVIC 3 MULTISPECTRAL</span>
            <h1 className={s.h1}>
              Your Field. Your Digital Twin. <span className={s.accent}>Zero Cloud.</span>
            </h1>
            <p className={s.lead}>
              Transform raw drone survey frames into an interactive 2D/3D digital twin—calibrated NDVI, crop-row geometry, Gaussian splats,
              and offline AI intelligence—running 100% on your local machine or farm server.
            </p>
            <div className={s.ctaRow}>
              <SignInButton />
            </div>
          </div>

          <div id="hero-viewer" className={`${s.blueprint} ${s.viewer}`}>
            <Corners />
            <div className={s.viewerBar}>
              <span>SURVEY · DITTY_ROAD_S04 · SOYBEAN R2</span>
              <span>EPSG:32616 · 1,378 FRAMES</span>
            </div>
            <div id="hero-stage" role="tabpanel" aria-label={activeMode.label} className={s.stage}>
              {MODES.map((m) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={m.k}
                  src={`/landing/hero-${m.k}.jpg`}
                  alt={m.alt}
                  className={s.fill}
                  hidden={m.k !== mode}
                  width={1100}
                  height={756}
                  loading={m.k === "ndvi" ? "eager" : "lazy"}
                  fetchPriority={m.k === "ndvi" ? "high" : "auto"}
                  decoding="async"
                />
              ))}
              <div aria-hidden="true" className={s.crosshair} />
              <div className={s.telemetry}>
                <div className={s.telemetryTitle}>FLIGHT TELEMETRY</div>
                <div>Alt: 30.2m AGL | Yaw: -53.2°</div>
                <div>
                  RTK Fix: <span className={s.okText}>FIXED</span> (1σ: 0.012m)
                </div>
              </div>
              <div className={s.legend}>
                <div className={s.legendLabel}>{activeMode.legendLabel}</div>
                <div className={s.ramp} style={{ background: activeMode.ramp }} />
                <div className={s.rampEnds}>
                  <span>{activeMode.lo}</span>
                  <span>{activeMode.hi}</span>
                </div>
              </div>
              <div className={s.health}>
                {HEALTH.map((h) => (
                  <span key={h.label} className={s.healthItem} style={{ color: h.color }}>
                    <Icon d={h.icon} size={13} />
                    <span>
                      <span className={s.healthWord}>{h.label}: </span>
                      <span className={s.healthPct}>{h.pct}</span>
                    </span>
                  </span>
                ))}
              </div>
            </div>
            <div role="tablist" aria-label="Viewer layer" className={s.tabs}>
              {MODES.map((m, i) => (
                <button
                  key={m.k}
                  type="button"
                  role="tab"
                  aria-selected={m.k === mode}
                  aria-controls="hero-stage"
                  className={s.tab}
                  onClick={() => setMode(m.k)}
                >
                  <span className={s.tabNo}>{String(i + 1).padStart(2, "0")}</span>
                  <span>{m.label}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className={`${s.section} ${s.surface}`} aria-label="Key numbers">
        <div className={`${s.wrap} ${s.metrics}`}>
          {METRICS.map((k) => (
            <div key={k.tag} className={s.metric}>
              <div className={s.metricTag}>{k.tag}</div>
              <div className={s.metricValue}>{k.value}</div>
              <div className={s.metricDesc}>{k.desc}</div>
            </div>
          ))}
        </div>
      </section>

      <section id="engine" className={s.section}>
        <div className={s.sectionInner}>
          <div className={s.sectionHead}>
            <div className={s.kicker}>TWO-STAGE ENGINE</div>
            <h2 className={s.h2}>A quick map in the field. A definitive twin overnight.</h2>
          </div>
          <div className={s.stageGrid}>
            {STAGES.map((st) => (
              <article key={st.title} className={`${s.blueprint} ${s.stageCard}`}>
                <Corners />
                <div className={s.stageTop}>
                  <span className={s.label}>{st.where}</span>
                  <span className={s.chip}>{st.badge}</span>
                </div>
                <h3 className={s.h3lg}>{st.title}</h3>
                <p className={s.body16}>{st.desc}</p>
                <ol className={s.pipeline} aria-label={`${st.title} steps`}>
                  {st.steps.map((step, i) => (
                    <li key={step}>
                      <span className={s.step}>{step}</span>
                      {i < st.steps.length - 1 && (
                        <span aria-hidden="true" className={s.arrow}>
                          →
                        </span>
                      )}
                    </li>
                  ))}
                </ol>
                <div className={s.bestFor}>
                  <span className={s.label}>BEST FOR</span>
                  <span className={s.body15}>{st.best}</span>
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section id="multispectral" className={s.section}>
        <div className={s.sectionInner}>
          <div className={s.sectionHead}>
            <div className={s.kicker}>MULTISPECTRAL &amp; CV</div>
            <h2 className={s.h2}>Measurements you can defend.</h2>
          </div>
          <div className={s.capGrid}>
            <div className={`${s.blueprint} ${s.radiometry}`}>
              <Corners />
              <div className={s.radiometryCopy}>
                <div className={s.label}>RADIOMETRY</div>
                <h3 className={s.h3lg}>
                  Calibrated Multispectral Radiometry <span className={s.muted}>(Not RGB Guesswork)</span>
                </h3>
                <p className={s.body16}>
                  Per-band SensorGainAdjustment, sun-sensor irradiance normalization and vignetting correction on every frame — so NDVI, NDRE
                  and GNDVI hold up across flights, days and seasons.
                </p>
                <div className={s.chipRow}>
                  {INDICES.map((ix) => (
                    <span key={ix} className={s.chip}>
                      {ix}
                    </span>
                  ))}
                </div>
              </div>
              <div className={s.bandTable} role="table" aria-label="Calibration per band">
                <div className={`${s.bandRow} ${s.bandHead}`} role="row">
                  <span role="columnheader">BAND</span>
                  <span role="columnheader">λ</span>
                  <span role="columnheader">GAIN</span>
                  <span role="columnheader">IRRAD.</span>
                  <span role="columnheader">VIGN.</span>
                </div>
                {BANDS.map((b) => (
                  <div key={b.name} className={s.bandRow} role="row">
                    <span className={s.bandName} role="cell">
                      <span className={s.swatch} style={{ background: b.swatch }} />
                      {b.name}
                    </span>
                    <span className={s.bandNm} role="cell">
                      {b.nm}
                    </span>
                    <span className={s.okText} role="cell" aria-label="corrected">
                      ✓
                    </span>
                    <span className={s.okText} role="cell" aria-label="corrected">
                      ✓
                    </span>
                    <span className={s.okText} role="cell" aria-label="corrected">
                      ✓
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div className={`${s.blueprint} ${s.capCard}`}>
              <Corners />
              <div className={`${s.figure} ${s.rows}`}>
                <div className={s.readout} style={{ left: 12, top: 12 }}>
                  <div>
                    ROW BEARING <span className={s.accent}>38.5°</span>
                  </div>
                  <div>
                    ROW SPACING <span className={s.accent}>0.40 m</span>
                  </div>
                </div>
                <div className={s.canopy}>
                  <div className={s.spread}>
                    <span>CANOPY CLOSURE</span>
                    <span className={s.warnText}>84%</span>
                  </div>
                  <div className={s.bar}>
                    <div className={s.barFill} style={{ width: "84%" }} />
                  </div>
                  <div className={s.halted}>
                    <Icon size={12}>
                      <rect x="6" y="5" width="4" height="14" />
                      <rect x="14" y="5" width="4" height="14" />
                    </Icon>
                    WEED DETECTION HALTED — CANOPY CLOSED
                  </div>
                </div>
              </div>
              <h3 className={s.h3}>Crop-Row Geometry &amp; Honest Canopy Closure</h3>
              <p className={s.body15}>
                Fourier/Hough row detection finds bearing and spacing. Weed candidates are flagged only while the canopy is open — past
                closure, AgroTwin stops rather than invent detections.
              </p>
            </div>

            <div className={`${s.blueprint} ${s.capCard}`}>
              <Corners />
              <div className={s.figure}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/landing/gcp.jpg" alt="Checkerboard ground control target found in a drone photo" className={s.fill} width={800} height={600} loading="lazy" decoding="async" />
                <div className={s.readout} style={{ left: 12, bottom: 12 }}>
                  <div>
                    MARKERS <span className={s.accent}>M1–M66</span>
                  </div>
                  <div>
                    MEDIAN RESIDUAL <span className={s.okText}>1.4 cm</span>
                  </div>
                </div>
              </div>
              <h3 className={s.h3}>Sub-Centimeter Ground Control (GCP) Engine</h3>
              <p className={s.body15}>
                Detects 40–60 cm checkerboards, pairs them with your GPS/UTM files and shifts georeferencing — without resampling a single image
                pixel.
              </p>
            </div>

            <div className={`${s.blueprint} ${s.capCard}`}>
              <Corners />
              <div className={s.figure}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/landing/splat.jpg" alt="Gaussian splat render of the field in 3D" className={s.fill} width={800} height={600} loading="lazy" decoding="async" />
                <div className={s.readout} style={{ left: 12, bottom: 12 }}>
                  SPZ · 3D TILES · CESIUMJS
                </div>
              </div>
              <h3 className={s.h3}>3D Gaussian Splats in CesiumJS</h3>
              <p className={s.body15}>
                SPZ-compressed 3D Tiles stream millions of photorealistic splats straight to the browser, with true ground depth and terrain
                slope.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section id="ai" className={`${s.section} ${s.surface}`}>
        <div className={s.aiInner}>
          <div className={s.aiCopy}>
            <div className={s.kicker}>FIELD AI</div>
            <h2 className={s.h2}>An offline scout that cites its sources.</h2>
            <p className={s.aiLead}>
              Ask about any zone. Answers are grounded in your survey data and agronomy references, retrieved and generated on your own
              hardware.
            </p>
          </div>
          <div className={`${s.blueprint} ${s.terminal}`}>
            <Corners />
            <div className={s.terminalBar}>
              <span>agrotwin://scout — ditty_road_s04</span>
            </div>
            <div className={s.terminalBody}>
              <div className={s.question}>
                <span className={s.accent}>›</span>
                <span>Why is there an attention zone along the southern boundary?</span>
              </div>
              <div className={s.answer}>
                <div className={s.answerTag}>AGROTWIN AI</div>
                <div>
                  Southern plot contains <span className={`${s.warnText} ${s.mono}`}>14.2%</span> low crop density (NDVI{" "}
                  <span className={s.mono}>0.35–0.50</span>). Measured row spacing remains <span className={s.mono}>0.40m</span>, but canopy
                  closure is only <span className={s.mono}>22%</span> due to water accumulation and residue.
                </div>
                <div className={s.sources}>
                  <div className={s.sourcesTag}>SOURCES CITED</div>
                  <div className={s.sourceList}>
                    {SOURCES.map((src) => (
                      <a key={src} href="#ai" className={s.source}>
                        <Icon d={FILE} size={12} style={{ flex: "none" }} />
                        {src}
                      </a>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section id="mobile" className={s.section}>
        <div className={s.sectionInner}>
          <div className={s.sectionHead}>
            <div className={s.kicker}>CONSOLE + COMPANION</div>
            <h2 className={s.h2}>Analyze at the desk. Walk it in the field.</h2>
          </div>
          <div className={s.devices}>
            <div className={`${s.blueprint} ${s.console}`}>
              <Corners />
              <div className={s.consoleBar}>
                <span>AgroTwin Console · CesiumJS</span>
                <span>{layersOn.length ? layersOn.join(" + ") : "No layers"}</span>
              </div>
              <div className={s.consoleBody}>
                <div className={s.layers}>
                  <div className={s.layersTitle}>LAYERS</div>
                  {LAYERS.map((k) => (
                    <button
                      key={k}
                      type="button"
                      className={s.layerBtn}
                      aria-pressed={layers[k]}
                      onClick={() => setLayers((prev) => ({ ...prev, [k]: !prev[k] }))}
                    >
                      <span className={s.checkbox}>
                        <Icon d={CHECK} size={11} strokeWidth={2.5} />
                      </span>
                      {k}
                    </button>
                  ))}
                </div>
                <div className={s.consoleImage}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src="/landing/console.jpg" alt="The AgroTwin console showing the field's 3D twin" className={s.fill} width={1000} height={558} loading="lazy" decoding="async" />
                </div>
              </div>
            </div>

            <div className={`${s.blueprint} ${s.phoneFrame}`}>
              <Corners />
              <div className={s.phone} aria-label="The AgroTwin phone app" role="img">
                <div className={s.phoneStatus}>
                  <span>9:41</span>
                  <span className={s.mono}>OFFLINE ✓</span>
                </div>
                <div className={s.phoneHead}>
                  <div className={s.phoneTitle}>Ditty Road</div>
                  <div className={s.phoneSub}>Soybean · surveyed this morning</div>
                </div>
                <div className={s.phoneStats}>
                  <div className={s.phoneStat}>
                    <div className={s.phoneStatValue}>42.6</div>
                    <div className={s.phoneStatLabel}>Acres</div>
                  </div>
                  <div className={s.phoneStat}>
                    <div className={s.phoneStatValue}>3</div>
                    <div className={s.phoneStatLabel}>Spots to check</div>
                  </div>
                </div>
                <div className={s.phoneMap}>
                  <div className={s.boundary} />
                  <div className={s.boundaryLabel}>BOUNDARY · CACHED OFFLINE</div>
                </div>
                <div className={s.ranked}>Ranked by severity</div>
                <div className={s.spotList}>
                  {SPOTS.map((sp) => (
                    <div key={sp.name} className={s.spot}>
                      <Icon d={sp.icon} stroke={sp.color} style={{ flex: "none" }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className={s.spotName}>{sp.name}</div>
                        <div className={s.spotWord} style={{ color: sp.color }}>
                          {sp.word}
                        </div>
                      </div>
                      <span className={s.spotDist}>{sp.dist}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <footer id="docs">
        <div className={s.footerInner}>
          <div className={s.ctaRow}>
            <SignInButton />
          </div>
          <div className={s.footerBase}>
            <span>AgroTwin</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
