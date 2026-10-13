import { Redirect } from "expo-router";
import { useAuth } from "@/providers/AuthProvider";

/** Entry: the Home tab when signed in, otherwise the sign-in screen. */
export default function Index() {
  const { ready, isAuthenticated } = useAuth();
  if (!ready) return null;
  return <Redirect href={isAuthenticated ? "/(tabs)" : "/login"} />;
}
