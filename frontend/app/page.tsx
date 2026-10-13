import { redirect } from "next/navigation";

// Signed-in people go straight to their fields (proxy.ts sends everyone else to /login).
export default function Home() {
  redirect("/dashboard");
}
