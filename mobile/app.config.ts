import type { ConfigContext, ExpoConfig } from "expo/config";

/**
 * Expo app configuration. Kept as TypeScript (instead of app.json) so the
 * Google Maps key for Android builds can come from the environment instead
 * of being committed. Expo Go ships with its own key; the value is only
 * needed for `expo run:android` / EAS builds.
 */
const googleMapsKey = process.env.GOOGLE_MAPS_ANDROID_API_KEY;
// A prebuild / run:android / EAS build without the key produces an app whose
// map is a blank beige canvas with only the Google logo (the Maps SDK refuses
// to draw tiles, polygons or markers when unauthorised). Expo Go ships its
// own key, so the warning is only raised for native builds.
const nativeBuild = process.env.EAS_BUILD === "true" || process.argv.some((a) => /^(prebuild|run:android|run:ios)$/.test(a));
if (nativeBuild && !googleMapsKey) {
  console.warn("[app.config] GOOGLE_MAPS_ANDROID_API_KEY is not set: the field map will be blank in this Android build (put the key in mobile/.env, see .env.example).");
}

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: "AgroTwin",
  slug: "agrotwin",
  version: "0.1.0",
  scheme: "agrotwin",
  orientation: "portrait",
  icon: "./assets/icon.png",
  userInterfaceStyle: "automatic",
  ios: {
    supportsTablet: true,
    bundleIdentifier: "com.agrotwin.mobile",
    infoPlist: {
      NSLocationWhenInUseUsageDescription:
        "AgroTwin shows your position on the field map so you can walk to areas that need inspection.",
      NSPhotoLibraryUsageDescription: "AgroTwin uploads drone images you select to your AgroTwin server.",
    },
  },
  android: {
    package: "com.agrotwin.mobile",
    adaptiveIcon: {
      backgroundColor: "#0f7a37",
      foregroundImage: "./assets/android-icon-foreground.png",
      backgroundImage: "./assets/android-icon-background.png",
      monochromeImage: "./assets/android-icon-monochrome.png",
    },
    // Local development talks to the laptop over plain http on the LAN. Expo Go
    // and debug builds allow cleartext; a release build needs the
    // expo-build-properties plugin (android.usesCleartextTraffic) or https.
    permissions: ["android.permission.ACCESS_COARSE_LOCATION", "android.permission.ACCESS_FINE_LOCATION"],
    config: googleMapsKey ? { googleMaps: { apiKey: googleMapsKey } } : undefined,
    predictiveBackGestureEnabled: false,
  },
  web: {
    favicon: "./assets/favicon.png",
    bundler: "metro",
  },
  plugins: [
    "expo-router",
    [
      "expo-splash-screen",
      {
        image: "./assets/splash-icon.png",
        imageWidth: 200,
        resizeMode: "contain",
        backgroundColor: "#0b0f0c",
      },
    ],
    "expo-secure-store",
    [
      "expo-image-picker",
      {
        photosPermission: "AgroTwin uploads drone images you select to your AgroTwin server.",
      },
    ],
    [
      "expo-location",
      {
        locationWhenInUsePermission:
          "AgroTwin shows your position on the field map so you can walk to areas that need inspection.",
      },
    ],
  ],
  experiments: {
    typedRoutes: true,
  },
  extra: {
    router: {},
  },
});
