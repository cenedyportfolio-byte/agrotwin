import { useRouter } from "expo-router";
import { EmptyState, Screen } from "@/components/ui";

export default function NotFound() {
  const router = useRouter();
  return (
    <Screen safeTop>
      <EmptyState title="This page doesn't exist" message="The link may be out of date." actionLabel="Go to Home" onAction={() => router.replace("/(tabs)")} />
    </Screen>
  );
}
