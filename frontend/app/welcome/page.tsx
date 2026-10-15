import type { Metadata } from "next";
import { Landing } from "@/components/landing/Landing";
import { landingFonts } from "@/components/landing/fonts";

export const metadata: Metadata = {
  title: "AgroTwin — Your Field. Your Digital Twin.",
  description:
    "Turn drone survey photos into an interactive 2D/3D digital twin of your field: calibrated crop health, crop rows, Gaussian splats and an offline AI scout, on your own server.",
};

/** Public: proxy.ts lets signed-out visitors through. The front door (/) shows it too. */
export default function WelcomePage() {
  return <Landing fontClassName={landingFonts} />;
}
