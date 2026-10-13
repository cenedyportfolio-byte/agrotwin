import { LayoutDashboard, Sprout, Camera, BarChart3, UploadCloud, Bot, Plane, Users } from "lucide-react";

export const NAV_ITEMS: { href: string; label: string; icon: typeof Users; adminOnly?: boolean }[] = [
  { href: "/dashboard", label: "Home", icon: LayoutDashboard },
  { href: "/fields", label: "Fields", icon: Sprout },
  { href: "/surveys", label: "Flights", icon: Camera },
  { href: "/analysis", label: "Crop health", icon: BarChart3 },
  { href: "/upload", label: "Upload", icon: UploadCloud },
  { href: "/flight-guide", label: "How to fly", icon: Plane },
  { href: "/ask-ai", label: "Ask AI", icon: Bot },
  { href: "/users", label: "Users", icon: Users, adminOnly: true },
];
