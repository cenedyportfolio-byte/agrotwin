import type { Metadata } from "next";
import { SignIn } from "@/components/landing/SignIn";
import { landingFonts } from "@/components/landing/fonts";

export const metadata: Metadata = {
  title: "Sign in — AgroTwin",
};

/** Public (proxy.ts). After signing in: back to the page that sent the visitor here, else the dashboard. */
export default function LoginPage() {
  return <SignIn fontClassName={landingFonts} />;
}
