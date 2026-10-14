import Link from "next/link";
import { SearchX } from "lucide-react";

/** Shown instead of a field or flight the server does not give this user:
 * deleted, or on another farm (the API answers "not found" for both). */
export function NotAvailable({ what }: { what: "field" | "flight" }) {
  return (
    <div className="mx-auto mt-16 max-w-sm rounded-xl border border-border bg-surface p-6 text-center">
      <SearchX className="mx-auto mb-3 text-muted-foreground" size={28} />
      <h1 className="font-semibold">This {what} isn&apos;t available</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        It may have been deleted, or it belongs to another farm. If you think it should be yours, ask your AgroTwin
        contact.
      </p>
      <Link href="/dashboard" className="mt-4 inline-block text-sm font-medium text-brand hover:underline">
        Back to your fields
      </Link>
    </div>
  );
}
