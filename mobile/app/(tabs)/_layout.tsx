import { Tabs } from "expo-router";
import { TabBar } from "@/components/navigation/TabBar";

export default function TabsLayout() {
  return (
    <Tabs screenOptions={{ headerShown: false }} tabBar={(props) => <TabBar {...props} />}>
      <Tabs.Screen name="index" options={{ title: "Home", tabBarAccessibilityLabel: "Home" }} />
      <Tabs.Screen name="fields" options={{ title: "Fields", tabBarAccessibilityLabel: "Fields" }} />
      <Tabs.Screen name="surveys" options={{ title: "Flights", tabBarAccessibilityLabel: "Flights" }} />
      <Tabs.Screen name="profile" options={{ title: "Profile", tabBarAccessibilityLabel: "Profile" }} />
    </Tabs>
  );
}
