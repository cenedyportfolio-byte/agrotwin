/**
 * Design tokens — the "Industry" design system from the Claude Design
 * handoff (mobile-app-design-kickoff/project/_ds/industry-…/styles.css) plus
 * the dark theme and status colours defined in "AgroTwin Mobile.dc.html".
 *
 * Industry is a blueprint wireframe: steel-blue accent on a light technical
 * ground, Barlow Condensed headings over Barlow, square corners, hairline
 * borders and "+" registration marks. Never use raw hex values in
 * components; import from here (mirrors the system's adherence lint rule).
 */
import type { TextStyle } from "react-native";

/** Converts a #rrggbb colour to rgba() — React Native has no color-mix(). */
export function alpha(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

export type StatusTier = "healthy" | "attention" | "problem" | "info" | "neutral";

export interface ThemeColors {
  bg: string;
  surface: string;
  text: string;
  accent: string;
  /** Text drawn on an accent fill (the design uses the page background). */
  onAccent: string;
  /** --color-divider: text at 16 % (light) / 20 % (dark). */
  divider: string;
  /** Row rules inside lists: text at 8 %. */
  hairline: string;
  /** Icon-box borders: text at 18 %. */
  boxBorder: string;
  /** Registration marks: text at 55 %. */
  corner: string;
  /** Secondary copy: text at 72 %. */
  muted: string;
  /** Body copy on cards: text at 82 %. */
  soft: string;
  /** Placeholder labels: text at 45 %. */
  faint: string;
  /** Skeleton blocks: text at 9 %. */
  skeleton: string;
  /** Empty track behind a progress bar: text at 8–10 %. */
  track: string;
  /** Selected list row / "me" chat bubble: accent at 12–14 %. */
  accentTint: string;
  /** Running processing step row: accent at 10 %. */
  accentTintSoft: string;
  /** Pressed state of hairline buttons: text at 7 %. */
  pressed: string;
  /** Sheet backdrop. */
  backdrop: string;
  healthy: string;
  attention: string;
  problem: string;
  info: string;
  neutral: string;
  shadowMd: { shadowColor: string; shadowOpacity: number; shadowRadius: number; shadowOffset: { width: number; height: number }; elevation: number };
  shadowLg: { shadowColor: string; shadowOpacity: number; shadowRadius: number; shadowOffset: { width: number; height: number }; elevation: number };
}

function build(base: { bg: string; surface: string; text: string; accent: string; dividerAlpha: number; ok: string; warn: string; bad: string; dark: boolean }): ThemeColors {
  const t = base.text;
  return {
    bg: base.bg,
    surface: base.surface,
    text: t,
    accent: base.accent,
    onAccent: base.bg,
    divider: alpha(t, base.dividerAlpha),
    hairline: alpha(t, 0.08),
    boxBorder: alpha(t, 0.18),
    corner: alpha(t, 0.55),
    muted: alpha(t, 0.72),
    soft: alpha(t, 0.82),
    faint: alpha(t, 0.45),
    skeleton: alpha(t, 0.09),
    track: alpha(t, 0.09),
    accentTint: alpha(base.accent, 0.13),
    accentTintSoft: alpha(base.accent, 0.1),
    pressed: alpha(t, 0.07),
    backdrop: "rgba(0, 0, 0, 0.45)",
    healthy: base.ok,
    attention: base.warn,
    problem: base.bad,
    info: base.accent,
    neutral: alpha(t, 0.72),
    shadowMd: base.dark
      ? { shadowColor: "#000000", shadowOpacity: 0.5, shadowRadius: 14, shadowOffset: { width: 0, height: 3 }, elevation: 4 }
      : { shadowColor: "#2b2b2d", shadowOpacity: 0.16, shadowRadius: 10, shadowOffset: { width: 0, height: 3 }, elevation: 3 },
    shadowLg: base.dark
      ? { shadowColor: "#000000", shadowOpacity: 0.6, shadowRadius: 40, shadowOffset: { width: 0, height: 16 }, elevation: 10 }
      : { shadowColor: "#2b2b2d", shadowOpacity: 0.22, shadowRadius: 32, shadowOffset: { width: 0, height: 12 }, elevation: 8 },
  };
}

// styles.css :root + the [data-theme="light"] status overrides in the canvas
const lightColors = build({
  bg: "#f2f2f3",
  surface: "#e9e9ea",
  text: "#1d1f20",
  accent: "#5980a6",
  dividerAlpha: 0.16,
  ok: "#4c8a5c",
  warn: "#b3862c",
  bad: "#b04f3d",
  dark: false,
});

// [data-theme="dark"] block in the canvas helmet
const darkColors = build({
  bg: "#14181b",
  surface: "#1c2125",
  text: "#e7eaec",
  accent: "#94bce3",
  dividerAlpha: 0.2,
  ok: "#77b483",
  warn: "#dfae55",
  bad: "#dd7a66",
  dark: true,
});

export const colorSchemes: Record<"light" | "dark", ThemeColors> = { light: lightColors, dark: darkColors };

/** Accent ramp (styles.css) — pressed/hover steps for the primary button. */
export const accentRamp = {
  400: "#94bce3",
  500: "#749dc4",
  600: "#597ea3",
  700: "#416180",
} as const;

/** Chrome drawn over the Digital Twin / image viewer (always dark, from the canvas). */
export const immersive = {
  bg: "#232629",
  viewerBg: "#0e1012",
  panel: "rgba(20, 22, 24, 0.8)",
  panelStrong: "rgba(20, 22, 24, 0.88)",
  border: "rgba(255, 255, 255, 0.25)",
  borderSoft: "rgba(255, 255, 255, 0.18)",
  text: "#ffffff",
  textMuted: "rgba(255, 255, 255, 0.78)",
  textFaint: "rgba(255, 255, 255, 0.6)",
} as const;

/** Font families (loaded in app/_layout.tsx from @expo-google-fonts). */
export const fonts = {
  heading: "BarlowCondensed_600SemiBold",
  body: "Barlow_400Regular",
  bodyMedium: "Barlow_500Medium",
  bodySemiBold: "Barlow_600SemiBold",
  bodyBold: "Barlow_700Bold",
} as const;

/** Layout constants measured from the canvas (402 px frame). */
export const layout = {
  pagePadding: 18,
  headerPadding: { top: 6, horizontal: 14, bottom: 14 },
  cardPadding: 15,
  cardPaddingLg: 18,
  cardGap: 10,
  sectionGap: 24,
  sectionGapSm: 20,
  bottomClearance: 120,
  tabBarHeight: 62,
  fabSize: 60,
  backButton: 44,
  tool: 50,
  toolSm: 48,
  /** Minimum touch target. */
  touch: 44,
} as const;

/** Registration-mark geometry from styles.css (.blueprint > .corner). */
export const cornerMark = { size: 11, offset: -6, arm: 5 } as const;

export const typography = {
  display: { fontFamily: fonts.heading, fontSize: 30, lineHeight: 33 },
  greeting: { fontFamily: fonts.heading, fontSize: 27, lineHeight: 30 },
  title: { fontFamily: fonts.heading, fontSize: 23, lineHeight: 25 },
  cardTitle: { fontFamily: fonts.heading, fontSize: 21, lineHeight: 23 },
  heading: { fontFamily: fonts.heading, fontSize: 19, lineHeight: 22 },
  headingSm: { fontFamily: fonts.heading, fontSize: 17, lineHeight: 19 },
  statXl: { fontFamily: fonts.heading, fontSize: 62, lineHeight: 56 },
  stat: { fontFamily: fonts.heading, fontSize: 34, lineHeight: 34 },
  number: { fontFamily: fonts.heading, fontSize: 22, lineHeight: 24 },
  numberSm: { fontFamily: fonts.heading, fontSize: 20, lineHeight: 22 },
  h6: { fontFamily: fonts.bodySemiBold, fontSize: 13, lineHeight: 16, letterSpacing: 1.04, textTransform: "uppercase" },
  kicker: { fontFamily: fonts.bodySemiBold, fontSize: 10, lineHeight: 12, letterSpacing: 1.6, textTransform: "uppercase" },
  kickerSm: { fontFamily: fonts.bodySemiBold, fontSize: 9, lineHeight: 11, letterSpacing: 1.26, textTransform: "uppercase" },
  body: { fontFamily: fonts.body, fontSize: 15, lineHeight: 22 },
  bodyMedium: { fontFamily: fonts.bodyMedium, fontSize: 15, lineHeight: 22 },
  bodyStrong: { fontFamily: fonts.bodySemiBold, fontSize: 15, lineHeight: 22 },
  bodySm: { fontFamily: fonts.body, fontSize: 14, lineHeight: 21 },
  bodySmStrong: { fontFamily: fonts.bodySemiBold, fontSize: 14, lineHeight: 21 },
  caption: { fontFamily: fonts.body, fontSize: 13, lineHeight: 18 },
  captionStrong: { fontFamily: fonts.bodySemiBold, fontSize: 13, lineHeight: 18 },
  small: { fontFamily: fonts.body, fontSize: 12, lineHeight: 16 },
  smallStrong: { fontFamily: fonts.bodySemiBold, fontSize: 12, lineHeight: 16 },
  tag: { fontFamily: fonts.body, fontSize: 11, lineHeight: 14, letterSpacing: 0.44 },
  tagUpper: { fontFamily: fonts.body, fontSize: 11, lineHeight: 14, letterSpacing: 0.66, textTransform: "uppercase" },
  label: { fontFamily: fonts.body, fontSize: 11, lineHeight: 14, letterSpacing: 0.44 },
  button: { fontFamily: fonts.heading, fontSize: 14, lineHeight: 17 },
  buttonMd: { fontFamily: fonts.heading, fontSize: 15, lineHeight: 18 },
  buttonLg: { fontFamily: fonts.heading, fontSize: 16, lineHeight: 19 },
} satisfies Record<string, TextStyle>;


/** Lucide stroke width the system prescribes. */
export const iconStroke = 1.5;
