import { useEffect } from "react";
import { Stack, useRouter, useSegments } from "expo-router";
import { StatusBar } from "expo-status-bar";
import * as SplashScreen from "expo-splash-screen";
import { useFonts } from "expo-font";
import { Barlow_400Regular } from "@expo-google-fonts/barlow/400Regular";
import { Barlow_500Medium } from "@expo-google-fonts/barlow/500Medium";
import { Barlow_600SemiBold } from "@expo-google-fonts/barlow/600SemiBold";
import { Barlow_700Bold } from "@expo-google-fonts/barlow/700Bold";
import { BarlowCondensed_600SemiBold } from "@expo-google-fonts/barlow-condensed/600SemiBold";
import { useTheme } from "@/hooks/useTheme";
import { AppProviders } from "@/providers/AppProviders";
import { useAuth } from "@/providers/AuthProvider";

SplashScreen.preventAutoHideAsync().catch(() => {});

/** Signed out: only the sign-in screen and the server address are reachable.
 * Signed in without the data agreement accepted: only the agreement. */
function useSignInGate() {
  const { ready, isAuthenticated, needsAgreement } = useAuth();
  const segments = useSegments();
  const router = useRouter();
  useEffect(() => {
    if (!ready) return;
    if (!isAuthenticated) {
      if (segments[0] !== "login" && segments[0] !== "settings") router.replace("/login");
    } else if (needsAgreement && segments[0] !== "agreement") {
      router.replace("/agreement");
    }
  }, [ready, isAuthenticated, needsAgreement, segments, router]);
}

function RootStack() {
  const { colors, isDark } = useTheme();
  useSignInGate();
  return (
    <>
      <StatusBar style={isDark ? "light" : "dark"} />
      <Stack
        screenOptions={{
          // Every screen draws its own header from the design (ScreenHeader).
          headerShown: false,
          contentStyle: { backgroundColor: colors.bg },
          animation: "slide_from_right",
        }}
      >
        <Stack.Screen name="index" />
        <Stack.Screen name="login" options={{ animation: "fade" }} />
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="map/[surveyId]" options={{ animation: "fade" }} />
        <Stack.Screen name="twin/[surveyId]" options={{ animation: "fade" }} />
        <Stack.Screen name="ai/chat" options={{ animation: "slide_from_bottom" }} />
      </Stack>
    </>
  );
}

export default function RootLayout() {
  // The Industry design system: Barlow Condensed headings over Barlow body.
  const [fontsLoaded, fontError] = useFonts({
    Barlow_400Regular,
    Barlow_500Medium,
    Barlow_600SemiBold,
    Barlow_700Bold,
    BarlowCondensed_600SemiBold,
  });

  useEffect(() => {
    if (fontsLoaded || fontError) SplashScreen.hideAsync().catch(() => {});
  }, [fontsLoaded, fontError]);

  if (!fontsLoaded && !fontError) return null;

  return (
    <AppProviders>
      <RootStack />
    </AppProviders>
  );
}
