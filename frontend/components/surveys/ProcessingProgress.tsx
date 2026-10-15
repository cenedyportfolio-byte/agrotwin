import { Check, Loader2, Circle, X, Clock } from "lucide-react";
import type { ProcessingJob, ProcessingStep } from "@/lib/types";
import { isJobActive } from "@/lib/api";
import { useMe } from "@/lib/useMe";
import { queueText } from "@/lib/queue";

const STATUS_LABEL: Record<string, string> = {
  PENDING: "Waiting for photos",
  UPLOADING: "Receiving photos",
  QUEUED: "Waiting in line",
  PROCESSING: "Working",
  GENERATING_ORTHOMOSAIC: "Building the field map",
  GENERATING_ANALYSIS: "Checking crop health",
  COMPLETED: "Done",
  FAILED: "Failed",
};

function StepRow({ step, isCurrent, running }: { step: ProcessingStep; isCurrent: boolean; running: boolean }) {
  const icon =
    step.status === "complete" ? (
      <Check size={16} className="text-healthy" />
    ) : step.status === "failed" ? (
      <X size={16} className="text-problem" />
    ) : isCurrent && running ? (
      <Loader2 size={16} className="animate-spin text-attention" />
    ) : isCurrent ? (
      <Clock size={15} className="text-muted-foreground" />
    ) : (
      <Circle size={14} className="text-muted-foreground" />
    );

  return (
    <div className="flex items-center gap-3 py-1.5 text-sm">
      {icon}
      <span className={step.status === "pending" && !isCurrent ? "text-muted-foreground" : ""}>
        {step.label}
        {isCurrent && step.note && <span className="block text-xs text-muted-foreground">{step.note}</span>}
      </span>
    </div>
  );
}

export function ProcessingProgress({
  job,
  title = "Creating Digital Twin",
  action,
}: {
  job: ProcessingJob;
  title?: string;
  /** Rendered under a failed job (typically a retry button). */
  action?: React.ReactNode;
}) {
  const running = isJobActive(job);
  return (
    <div className="rounded-xl border border-border bg-surface p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold text-sm">{title}</h3>
        <span
          className={`text-xs font-medium ${
            job.status === "FAILED" ? "text-problem" : job.status === "COMPLETED" ? "text-healthy" : "text-muted-foreground"
          }`}
        >
          {STATUS_LABEL[job.status] ?? job.status}
        </span>
      </div>
      {job.status === "QUEUED" && job.queue && <p className="-mt-1 mb-2 text-xs text-muted-foreground">{queueText(job.queue)}</p>}
      <div>
        {job.steps.map((step) => (
          <StepRow key={step.key} step={step} isCurrent={job.current_step === step.key} running={running && job.status !== "QUEUED"} />
        ))}
      </div>
      {job.status === "FAILED" && (
        <div className="mt-3 space-y-2 border-t border-border pt-3">
          <div className="text-xs text-problem break-words">{job.error_message ?? "Processing failed."}</div>
          <StaffDetail detail={job.error_detail} />
          {action}
        </div>
      )}
    </div>
  );
}

function StaffDetail({ detail }: { detail: string | null | undefined }) {
  const { isStaff } = useMe();
  if (!isStaff || !detail) return null;
  return <div className="font-mono text-[11px] text-muted-foreground break-words">Staff detail: {detail}</div>;
}
