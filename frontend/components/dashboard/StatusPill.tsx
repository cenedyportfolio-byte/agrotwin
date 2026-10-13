import clsx from "clsx";
import { Badge } from "@/components/ui/badge";
import { METHOD_DESCRIPTION, METHOD_LABEL } from "@/lib/frames";
import type { AnalysisMethod } from "@/lib/types";

const DOT: Record<string, string> = {
  healthy: "bg-healthy",
  attention: "bg-attention",
  problem: "bg-problem",
};

export function StatusDot({ kind, label }: { kind: "healthy" | "attention" | "problem"; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs">
      <span className={clsx("h-2 w-2 rounded-full", DOT[kind])} />
      {label}
    </span>
  );
}

/** Only ever rendered when an analysis reports is_mock — nothing in the
 * current pipeline sets that flag; it stays as a safety net. */
export function MockDataBadge() {
  return (
    <Badge variant="outline" className="border-attention/40 bg-attention/10 text-attention uppercase tracking-wide">
      Demo Data
    </Badge>
  );
}

export function MethodBadge({ method }: { method: AnalysisMethod | null | undefined }) {
  if (!method) return null;
  return (
    <Badge variant="outline" className="text-muted-foreground font-normal" title={METHOD_DESCRIPTION[method]}>
      {METHOD_LABEL[method] ?? method}
    </Badge>
  );
}
