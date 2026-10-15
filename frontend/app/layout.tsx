import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "AgroTwin — Agricultural Digital Twin",
  description: "Your Field. Your Digital Twin. Your Insights.",
};

// The full screen on phones with a notch or home bar (the frame keeps clear of
// them with env(safe-area-inset-*), components/layout/AppShell.tsx).
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

const THEME_INIT_SCRIPT = `
(function () {
  try {
    var stored = localStorage.getItem("agrotwin-theme");
    // light unless the visitor chose otherwise; "system" (the landing page's
    // third choice) follows the device
    var theme = stored === "dark" ? "dark" : stored === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", theme);
  } catch (e) {}
})();
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        {/* CesiumJS widget styles from the prebuilt copy (Cesium itself is loaded at runtime, see lib/loadCesium.ts) */}
        <link rel="stylesheet" href="/cesium/Widgets/widgets.css" />
      </head>
      <body className="min-h-full h-full flex flex-col">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
