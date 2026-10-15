import { LayoutDashboard, Sprout, Camera, BarChart3, UploadCloud, Bot, Plane, Users, ListOrdered } from "lucide-react";

export const NAV_ITEMS: { href: string; label: string; icon: typeof Users; adminOnly?: boolean; staffOnly?: boolean }[] = [
  { href: "/dashboard", label: "Home", icon: LayoutDashboard },
  { href: "/fields", label: "Fields", icon: Sprout },
  { href: "/surveys", label: "Flights", icon: Camera },
  { href: "/analysis", label: "Crop health", icon: BarChart3 },
  { href: "/upload", label: "Upload", icon: UploadCloud },
  { href: "/flight-guide", label: "How to fly", icon: Plane },
  { href: "/ask-ai", label: "Ask AI", icon: Bot },
  { href: "/queue", label: "Queue", icon: ListOrdered, staffOnly: true },
  { href: "/users", label: "Users", icon: Users, adminOnly: true },
];

/** The items this user may open: Queue for staff, Users for admins. */
export function navItemsFor({ isStaff, isAdmin }: { isStaff: boolean; isAdmin: boolean }) {
  return NAV_ITEMS.filter((it) => (!it.adminOnly || isAdmin) && (!it.staffOnly || isStaff));
}
