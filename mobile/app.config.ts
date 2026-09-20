import type { ConfigContext, ExpoConfig } from "expo/config";

/**
 * Expo app configuration. Kept as TypeScript (instead of app.json) so values
 * can come from the environment when needed.
 *
 * The Field Map is the website's Cesium map shown in a WebView, so the app
 * uses no native map SDK and needs no Google Maps API key on any platform.
 */
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
