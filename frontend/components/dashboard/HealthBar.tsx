import { HEALTH_EXPLAINER, pct } from "@/lib/farm";

/** The field's healthy / needs-attention / problem shares, each with its word,
 * and (optionally) what they are compared with. */
export function HealthBar({
  healthy,
  attention,
  problem,
  explain = false,
}: {
  healthy: number | null | undefined;
  attention: number | null | undefined;
  problem: number | null | undefined;
  explain?: boolean;
}) {
  return (
    <div className="space-y-2">
      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-surface-2">
        <div className="bg-healthy" style={{ width: `${healthy ?? 0}%` }} />
        <div className="bg-attention" style={{ width: `${attention ?? 0}%` }} />
        <div className="bg-problem" style={{ width: `${problem ?? 0}%` }} />
      </div>
      <div className="grid grid-cols-3 gap-2 text-xs">
        <Share color="bg-healthy" value={healthy} label="healthy" />
        <Share color="bg-attention" value={attention} label="needs attention" />
        <Share color="bg-problem" value={problem} label="problem" />
      </div>
      {explain && <p className="text-[11px] leading-snug text-muted-foreground">{HEALTH_EXPLAINER}</p>}
    </div>
  );
}

function Share({ color, value, label }: { color: string; value: number | null | undefined; label: string }) {
  return (
    <div className="flex items-start gap-1.5">
      <span className={`mt-1 inline-block h-2 w-2 shrink-0 rounded-full ${color}`} />
      <span>
        <span className="font-semibold">{pct(value)}</span> <span className="text-muted-foreground">{label}</span>
      </span>
    </div>
  );
}
