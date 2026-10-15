import { useEffect, useState } from "react";
import { Alert, StyleSheet, View } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { Crosshair } from "lucide-react-native";
import { iconStroke } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import { useAttachGcpFile, useDeleteGcpFile, useGcpCheck, useGcpFileCheck } from "@/features/gcp/hooks";
import { queryKeys } from "@/features/queryKeys";
import { describeError } from "@/services/errors";
import { gcpService } from "@/services/gcp";
import type { LocalFile } from "@/services/surveys";
import type { GcpReportStatus } from "@/types";
import { formatDistance } from "@/utils/format";
import { AppText, Blueprint, Button } from "@/components/ui";
import type { TextTone } from "@/components/ui";
import { GcpFileFields } from "./GcpFileFields";

const STATUS_TONE: Record<GcpReportStatus, TextTone> = {
  none: "muted",
  waiting: "muted",
  no_match: "problem",
  check_only: "muted",
  applied: "healthy",
  aligned: "healthy",
  rejected: "problem",
};

/** A flight's ground control points: add, replace or remove the file, and how
 * the detailed map compares with each surveyed point (before / after lining up).
 * Same as the website's GcpCard. */
export function GcpCard({ surveyId, busy, initialError }: { surveyId: string; busy: boolean; initialError?: string | null }) {
  const { colors } = useTheme();
  const qc = useQueryClient();
  const check = useGcpCheck(surveyId);
  const attach = useAttachGcpFile(surveyId);
  const remove = useDeleteGcpFile(surveyId);
  const [editing, setEditing] = useState(false);
  const [file, setFile] = useState<LocalFile | null>(null);
  const [rtk, setRtk] = useState(false);
  const [epsg, setEpsg] = useState("");
  const read = useGcpFileCheck(file, epsg, (f, code) => gcpService.uploadFile(surveyId, f, { rtk: false, epsg: code, dryRun: true }));

  // a lining-up job just finished: show its outcome
  useEffect(() => {
    if (!busy) qc.invalidateQueries({ queryKey: queryKeys.gcpCheck(surveyId) });
  }, [busy, qc, surveyId]);

  const report = check.data?.report ?? null;
  const fileInfo = check.data?.file ?? null;
  const showForm = editing || !fileInfo;
  const applied = report?.status === "applied";

  const submit = () => {
    if (!file) return;
    attach.mutate(
      { file, rtk, epsg },
      {
        onSuccess: () => {
          setEditing(false);
          setFile(null);
        },
      }
    );
  };

  const confirmRemove = () =>
    Alert.alert("Remove the surveyed points?", "A map lined up with them goes back to how it was made.", [
      { text: "Cancel", style: "cancel" },
      { text: "Remove", style: "destructive", onPress: () => remove.mutate() },
    ]);

  return (
    <Blueprint style={{ gap: 12 }}>
      <View style={styles.head}>
        <Crosshair size={18} color={colors.accent} strokeWidth={iconStroke} />
        <AppText variant="heading" style={{ flex: 1 }}>
          Ground control points
        </AppText>
        {!fileInfo ? (
          <AppText variant="caption" tone="muted">
            Optional
          </AppText>
        ) : null}
      </View>

      {initialError && !fileInfo ? (
        <AppText variant="bodySm" tone="problem">
          The ground control points file could not be used: {initialError}
        </AppText>
      ) : null}

      {fileInfo && !editing ? (
        <>
          <AppText variant="caption" tone="muted">
            {fileInfo.points.length} {fileInfo.points.length === 1 ? "point" : "points"} from {fileInfo.filename ?? "the file"} ·{" "}
            {fileInfo.rtk ? "measured with RTK" : "handheld GPS (compared only)"}
          </AppText>
          {report?.message ? (
            <AppText variant="bodySm" tone={STATUS_TONE[report.status]}>
              {report.message}
            </AppText>
          ) : null}
          {report && report.points.length > 0 && report.status !== "waiting" ? (
            <View>
              {report.points.map((p, i) => (
                <View key={p.name} style={[styles.point, i > 0 && { borderTopWidth: 1, borderTopColor: colors.hairline }]}>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <AppText variant="bodySmStrong">{p.name}</AppText>
                    <AppText variant="caption" tone="muted">
                      {p.matched ? `Target ${p.matched}` : "No target nearby"}
                      {applied && !p.used && p.matched ? " · not used — check this point" : ""}
                    </AppText>
                  </View>
                  <View style={{ alignItems: "flex-end" }}>
                    <AppText variant="bodySm" tabular>
                      {formatDistance(p.before_m)}
                    </AppText>
                    {applied ? (
                      <AppText variant="caption" tone="healthy" tabular>
                        {formatDistance(p.after_m)} after
                      </AppText>
                    ) : null}
                  </View>
                </View>
              ))}
            </View>
          ) : null}
          <View style={styles.buttons}>
            <Button label="Replace" variant="secondary" onPress={() => setEditing(true)} disabled={busy} style={{ flex: 1 }} />
            <Button label="Remove" variant="secondary" onPress={confirmRemove} disabled={busy} loading={remove.isPending} style={{ flex: 1 }} />
          </View>
          {remove.isError ? (
            <AppText variant="bodySm" tone="problem">
              {describeError(remove.error).message}
            </AppText>
          ) : null}
        </>
      ) : null}

      {showForm ? (
        <>
          {!fileInfo ? (
            <AppText variant="caption" tone="muted">
              If you surveyed the checkerboard targets of this flight, add their positions (CSV from your GPS, or OpenDroneMap’s gcp_list.txt). RTK points line the
              detailed map up with them; handheld points are compared.
            </AppText>
          ) : null}
          <GcpFileFields
            file={file}
            onFile={setFile}
            rtk={rtk}
            onRtk={setRtk}
            epsg={epsg}
            onEpsg={setEpsg}
            info={read.info}
            error={read.error}
            checking={read.checking}
            disabled={busy || attach.isPending}
          />
          {attach.isError ? (
            <AppText variant="bodySm" tone="problem">
              {describeError(attach.error).message}
            </AppText>
          ) : null}
          <View style={styles.buttons}>
            <Button
              label={fileInfo ? "Use this file" : "Add points"}
              onPress={submit}
              disabled={!file || !read.info || !!read.error || read.checking || busy}
              loading={attach.isPending}
              style={{ flex: 1 }}
            />
            {editing ? <Button label="Cancel" variant="secondary" onPress={() => setEditing(false)} style={{ flex: 1 }} /> : null}
          </View>
          {busy ? (
            <AppText variant="caption" tone="muted">
              The flight is being processed — the points can be changed when it finishes.
            </AppText>
          ) : null}
        </>
      ) : null}
    </Blueprint>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: "row", alignItems: "center", gap: 8 },
  point: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8 },
  buttons: { flexDirection: "row", gap: 8 },
});
