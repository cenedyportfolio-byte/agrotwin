import Link from "next/link";
import { ArrowRight, MapPin } from "lucide-react";
import type { FieldSummary } from "@/lib/types";
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { fieldStatus, formatArea } from "@/lib/farm";
import { HealthBar } from "./HealthBar";
import { MethodBadge, MockDataBadge } from "./StatusPill";

const STATUS_CLASS = {
  healthy: "border-healthy/40 bg-healthy/10 text-healthy",
  attention: "border-attention/40 bg-attention/10 text-attention",
  problem: "border-problem/40 bg-problem/10 text-problem",
  none: "border-border text-muted-foreground",
};

export function FieldCard({ field }: { field: FieldSummary }) {
  const status = fieldStatus(field);
  const area = formatArea(field.area_hectares);

  return (
    <Card className="gap-4">
      <CardHeader className="flex items-start justify-between gap-2">
        <Link href={`/fields/${field.id}`} className="min-w-0 hover:underline">
          <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">{field.crop_type}</div>
          <h3 className="font-semibold text-lg leading-tight">{field.name}</h3>
          {area && (
            <div className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
              <MapPin size={12} /> {area}
            </div>
          )}
        </Link>
        <div className="flex items-center gap-2">
          <MethodBadge method={field.analysis_method} />
          {field.analysis_is_mock && <MockDataBadge />}
        </div>
      </CardHeader>

      <CardContent>
        {field.healthy_area_percent != null ? (
          <HealthBar
            healthy={field.healthy_area_percent}
            attention={field.attention_area_percent}
            problem={field.problem_area_percent}
          />
        ) : (
          <div className="text-xs text-muted-foreground">
            {field.latest_survey_status && field.latest_survey_status !== "COMPLETED"
              ? "The latest flight is still being processed."
              : "No flight uploaded yet."}
          </div>
        )}
      </CardContent>

      <CardFooter className="flex items-center justify-between text-xs">
        <Badge variant="outline" className={STATUS_CLASS[status.kind]}>
          {status.label}
        </Badge>
        <Link
          href={`/fields/${field.id}/digital-twin`}
          className="inline-flex items-center gap-1 font-medium text-brand hover:underline"
        >
          Open field map <ArrowRight size={14} />
        </Link>
      </CardFooter>
    </Card>
  );
}
