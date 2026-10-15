import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import WelcomePage, { metadata as welcomeMetadata } from "./welcome/page";

const SESSION_COOKIE = "agrotwin_session"; // as in proxy.ts and the backend

export const metadata = welcomeMetadata;

// The site's front door: signed-in people go straight to their fields; everyone
// else sees the landing page (also at /welcome), whose Sign In leads to /login.
export default async function Home() {
  if ((await cookies()).has(SESSION_COOKIE)) redirect("/dashboard");
  return <WelcomePage />;
}
