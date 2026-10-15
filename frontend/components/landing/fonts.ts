import { Barlow, Barlow_Condensed } from "next/font/google";

// The landing and sign-in pages' type: Barlow Condensed headings over Barlow
// (the design's Industry system). next/font serves them from this server, so a
// visit makes no request to Google. Geist Mono comes from the root layout.
const barlow = Barlow({ subsets: ["latin"], weight: ["400", "500", "700"], variable: "--font-barlow" });
const barlowCondensed = Barlow_Condensed({ subsets: ["latin"], weight: ["400", "600"], variable: "--font-barlow-condensed" });

/** Class names that define --font-barlow and --font-barlow-condensed. */
export const landingFonts = `${barlow.variable} ${barlowCondensed.variable}`;
