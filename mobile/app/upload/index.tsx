import { useEffect, useMemo, useState } from "react";
import { StyleSheet, Switch, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { BookOpen, Crosshair, FileUp, ImagePlus, Monitor } from "lucide-react-native";
import { mobileUploadSoftLimit } from "@/constants/config";
import { iconStroke, layout } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import { useCreateField, useFields } from "@/features/fields/hooks";
import { useCreateSurvey, useSurveys } from "@/features/surveys/hooks";
import { useGcpFileCheck } from "@/features/gcp/hooks";
import { pickAssetFile, pickDroneImages, pickImageFiles } from "@/features/upload/pickers";
import { useUploadFlow } from "@/features/upload/useUploadFlow";
import { IMPORTABLE_ASSET_TYPES, type ImportableAssetType } from "@/services/assets";
import { describeError } from "@/services/errors";
import { gcpService } from "@/services/gcp";
import { useAuth } from "@/providers/AuthProvider";
import type { LocalFile } from "@/services/surveys";
import { formatDate, formatNumber, plural } from "@/utils/format";
import { Blueprint, Button, Chip, ErrorState, LoadingState, Screen, ScreenHeader, SectionHeader, AppText } from "@/components/ui";
import { NewFieldForm } from "@/components/upload/NewFieldForm";
import { NewSurveyForm } from "@/components/upload/NewSurveyForm";
import { UploadProgressCard } from "@/components/upload/UploadProgressCard";
import { GcpFileFields } from "@/components/gcp/GcpFileFields";

type Mode = "images" | "asset";

export default function UploadScreen() {
  const params = useLocalSearchParams<{ fieldId?: string; surveyId?: string }>();
  const router = useRouter();
  const { colors } = useTheme();
  // importing maps made elsewhere is a staff tool (the server refuses it for farmers)
  const { isStaff } = useAuth();

  const fields = useFields();
  const surveys = useSurveys();
  const createField = useCreateField();
  const createSurvey = useCreateSurvey();

  const [fieldId, setFieldId] = useState<string | null>(params.fieldId ?? null);
  const [newField, setNewField] = useState(false);
  const [surveyId, setSurveyId] = useState<string | null>(params.surveyId ?? null);
  const [newSurvey, setNewSurvey] = useState(false);
  const [mode, setMode] = useState<Mode>("images");
  const [files, setFiles] = useState<LocalFile[]>([]);
  const [assetType, setAssetType] = useState<ImportableAssetType>("orthomosaic");
  const [assetFile, setAssetFile] = useState<LocalFile | null>(null);
  const [startProcessing, setStartProcessing] = useState(true);
  const [formError, setFormError] = useState<string | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  const [showGcp, setShowGcp] = useState(false);
  const [gcpFile, setGcpFile] = useState<LocalFile | null>(null);
  const [gcpRtk, setGcpRtk] = useState(false);
  const [gcpEpsg, setGcpEpsg] = useState("");
  const gcp = useGcpFileCheck(gcpFile, gcpEpsg, (file, epsg) => gcpService.checkFile(file, { epsg, fieldId }));

  const { progress, uploadImages, uploadAsset, cancel, reset } = useUploadFlow(surveyId);

  // A survey chosen via deep link implies its field.
  useEffect(() => {
    if (params.surveyId && surveys.data) {
      const s = surveys.data.find((x) => x.id === params.surveyId);
      if (s) setFieldId(s.field_id);
    }
  }, [params.surveyId, surveys.data]);

  const fieldSurveys = useMemo(() => (surveys.data ?? []).filter((s) => s.field_id === fieldId), [surveys.data, fieldId]);
  const openSurveys = fieldSurveys.filter((s) => ["PENDING", "UPLOADING", "COMPLETED", "FAILED"].includes(s.status));
  const busy = progress.state === "UPLOADING" || progress.state === "PROCESSING";

  const onCreateField = async (v: { name: string; crop_type: string }) => {
    setFormError(null);
    try {
      const created = await createField.mutateAsync({ name: v.name, crop_type: v.crop_type });
      setFieldId(created.id);
      setNewField(false);
    } catch (err) {
      setFormError(describeError(err).message);
    }
  };

  const onCreateSurvey = async (v: { field_id: string; name: string; drone_model?: string }) => {
    setFormError(null);
    try {
      const created = await createSurvey.mutateAsync({ field_id: v.field_id, name: v.name, drone_model: v.drone_model || undefined });
      setSurveyId(created.id);
      setNewSurvey(false);
    } catch (err) {
      setFormError(describeError(err).message);
    }
  };

  const choose = async (fn: () => Promise<LocalFile[] | null>) => {
    setPickError(null);
    try {
      const picked = await fn();
      if (picked === null) {
        setPickError("Photo library permission was not granted.");
        return;
      }
      setFiles((prev) => {
        const seen = new Set(prev.map((f) => f.name));
        return [...prev, ...picked.filter((f) => !seen.has(f.name))];
      });
    } catch (err) {
      setPickError(describeError(err).message);
    }
  };

  const chooseAsset = async () => {
    setPickError(null);
    try {
      const picked = await pickAssetFile();
      if (picked) setAssetFile(picked);
    } catch (err) {
      setPickError(describeError(err).message);
    }
  };

  const start = () => {
    if (!surveyId) return;
    if (mode === "images") void uploadImages(files, startProcessing, gcpFile ? { file: gcpFile, rtk: gcpRtk, epsg: gcpEpsg } : null);
    else if (assetFile) void uploadAsset(assetType, assetFile);
  };

  if (fields.isPending || surveys.isPending) {
    return (
      <Screen safeTop padded={false}>
        <ScreenHeader title="Upload a flight" />
        <View style={styles.body}>
          <LoadingState cards={2} />
        </View>
      </Screen>
    );
  }
  if (fields.isError) {
    return (
      <Screen safeTop padded={false}>
        <ScreenHeader title="Upload a flight" />
        <ErrorState error={fields.error} onRetry={() => fields.refetch()} />
      </Screen>
    );
  }

  // a chosen GCP file must have been read without a problem first
  const gcpReady = !gcpFile || (!!gcp.info && !gcp.error && !gcp.checking);
  const canUpload = !!surveyId && !busy && (mode === "images" ? files.length > 0 && gcpReady : !!assetFile);

  return (
    <Screen safeTop padded={false} bottomInset={layout.bottomClearance}>
      <ScreenHeader title="Upload a flight" subtitle={`Step ${progress.state !== "IDLE" ? 4 : surveyId ? 3 : fieldId ? 2 : 1} of 4`} />
      <View style={styles.body}>
        <Blueprint style={{ marginBottom: 20 }}>
          <View style={styles.row}>
            <Monitor size={20} color={colors.accent} strokeWidth={iconStroke} />
            <AppText variant="bodyStrong" style={{ flex: 1 }}>
              Large flights: use the website
            </AppText>
          </View>
          <AppText variant="caption" tone="muted" style={{ marginTop: 4 }}>
            A full flight is often a thousand photos and many gigabytes. Upload those on the AgroTwin website from a computer, or from this
            phone's browser with Wi-Fi. The app is good for small batches and single photos.
          </AppText>
          <Button
            label="How to fly your field"
            variant="ghost"
            size="sm"
            align="start"
            icon={<BookOpen size={16} color={colors.accent} strokeWidth={iconStroke} />}
            onPress={() => router.push("/flight-guide")}
            style={{ marginTop: 6 }}
          />
        </Blueprint>

        <View style={{ marginBottom: 20 }}>
          <SectionHeader title="1 · Field" actionLabel={newField ? "Choose existing" : "New field"} onAction={() => setNewField((v) => !v)} />
          {newField ? (
            <Blueprint>
              <NewFieldForm onSubmit={onCreateField} submitting={createField.isPending} error={formError} />
            </Blueprint>
          ) : (fields.data ?? []).length === 0 ? (
            <Blueprint>
              <AppText variant="body" tone="muted">
                No fields yet — create one.
              </AppText>
              <Button label="New field" variant="secondary" onPress={() => setNewField(true)} style={{ marginTop: 12 }} />
            </Blueprint>
          ) : (
            <View style={styles.chips}>
              {(fields.data ?? []).map((f) => (
                <Chip
                  key={f.id}
                  label={f.name}
                  selected={fieldId === f.id}
                  onPress={() => {
                    setFieldId(f.id);
                    setSurveyId(null);
                  }}
                  disabled={busy}
                />
              ))}
            </View>
          )}
        </View>

        {fieldId ? (
          <View style={{ marginBottom: 20 }}>
            <SectionHeader title="2 · Flight" actionLabel={newSurvey ? "Choose existing" : "New flight"} onAction={() => setNewSurvey((v) => !v)} />
            {newSurvey || openSurveys.length === 0 ? (
              <Blueprint>
                {openSurveys.length === 0 && !newSurvey ? (
                  <AppText variant="caption" tone="muted" style={{ marginBottom: 12 }}>
                    No flights for this field yet — name this one.
                  </AppText>
                ) : null}
                <NewSurveyForm key={fieldId} fieldId={fieldId} onSubmit={onCreateSurvey} submitting={createSurvey.isPending} error={formError} />
              </Blueprint>
            ) : (
              <View style={styles.chips}>
                {openSurveys.map((s) => (
                  <Chip key={s.id} label={`${s.name} · ${formatDate(s.survey_date ?? s.created_at)}`} selected={surveyId === s.id} onPress={() => setSurveyId(s.id)} disabled={busy} />
                ))}
              </View>
            )}
          </View>
        ) : null}

        {surveyId ? (
          <View style={{ marginBottom: 20 }}>
            <SectionHeader title={isStaff ? "3 · What to upload" : "3 · Photos"} />
            {isStaff ? (
              <View style={[styles.chips, { marginBottom: 12 }]}>
                <Chip label="Drone photos" selected={mode === "images"} onPress={() => setMode("images")} disabled={busy} />
                <Chip label="Processed file" selected={mode === "asset"} onPress={() => setMode("asset")} disabled={busy} />
              </View>
            ) : null}
            {mode === "images" ? (
              <Blueprint>
                <AppText variant="caption" tone="muted">
                  The original JPG / TIF photos from the drone's memory card. Photos already received are skipped, so you can safely try again.
                </AppText>
                <View style={[styles.row, { marginTop: 12, flexWrap: "wrap" }]}>
                  <Button label="Choose photos" variant="secondary" icon={<ImagePlus size={16} color={colors.text} strokeWidth={iconStroke} />} onPress={() => choose(pickDroneImages)} disabled={busy} />
                  <Button label="Choose files" variant="secondary" icon={<FileUp size={16} color={colors.text} strokeWidth={iconStroke} />} onPress={() => choose(pickImageFiles)} disabled={busy} />
                </View>
                {files.length > 0 ? (
                  <View style={{ marginTop: 12, gap: 4 }}>
                    <AppText variant="bodyStrong">{plural(files.length, "file")} selected</AppText>
                    <AppText variant="caption" tone="muted" numberOfLines={2}>
                      {files
                        .slice(0, 4)
                        .map((f) => f.name)
                        .join(", ")}
                      {files.length > 4 ? ` … +${formatNumber(files.length - 4)}` : ""}
                    </AppText>
                    {files.length > mobileUploadSoftLimit ? (
                      <AppText variant="caption" tone="attention">
                        ⚠ {formatNumber(files.length)} files is a lot for a phone upload. For a whole flight, the AgroTwin website on a computer is faster.
                      </AppText>
                    ) : null}
                    <Button label="Clear selection" variant="ghost" align="start" size="sm" onPress={() => setFiles([])} disabled={busy} />
                  </View>
                ) : null}
                <View style={[styles.row, { marginTop: 12 }]}>
                  <Switch value={startProcessing} onValueChange={setStartProcessing} disabled={busy} trackColor={{ true: colors.accent }} accessibilityLabel="Make the map when the upload finishes" />
                  <AppText variant="body" style={{ flex: 1 }}>
                    Make the map when the upload finishes
                  </AppText>
                </View>
              </Blueprint>
            ) : null}
            {mode === "images" ? (
              <Blueprint style={{ marginTop: 12 }}>
                {showGcp || gcpFile ? (
                  <View style={{ gap: 10 }}>
                    <View style={styles.row}>
                      <Crosshair size={18} color={colors.accent} strokeWidth={iconStroke} />
                      <AppText variant="bodyStrong" style={{ flex: 1 }}>
                        Ground control points (optional)
                      </AppText>
                    </View>
                    <AppText variant="caption" tone="muted">
                      If you measured the checkerboard targets with a GPS: the file from your GPS (latitude / longitude or easting / northing), or OpenDroneMap’s gcp_list.txt.
                    </AppText>
                    <GcpFileFields
                      file={gcpFile}
                      onFile={setGcpFile}
                      rtk={gcpRtk}
                      onRtk={setGcpRtk}
                      epsg={gcpEpsg}
                      onEpsg={setGcpEpsg}
                      info={gcp.info}
                      error={gcp.error}
                      checking={gcp.checking}
                      disabled={busy}
                    />
                  </View>
                ) : (
                  <Button
                    label="Add ground control points (optional)"
                    variant="ghost"
                    size="sm"
                    align="start"
                    icon={<Crosshair size={16} color={colors.accent} strokeWidth={iconStroke} />}
                    onPress={() => setShowGcp(true)}
                    disabled={busy}
                  />
                )}
              </Blueprint>
            ) : (
              <Blueprint>
                <AppText variant="caption" tone="muted">
                  Import results produced elsewhere. Only georeferenced files are accepted; the server explains what to export if a file is rejected.
                </AppText>
                <View style={[styles.chips, { marginTop: 12 }]}>
                  {IMPORTABLE_ASSET_TYPES.map((t) => (
                    <Chip key={t.value} label={t.label} selected={assetType === t.value} onPress={() => setAssetType(t.value)} disabled={busy} />
                  ))}
                </View>
                <Button label={assetFile ? `File: ${assetFile.name}` : "Choose file"} variant="secondary" icon={<FileUp size={16} color={colors.text} strokeWidth={iconStroke} />} onPress={chooseAsset} disabled={busy} style={{ marginTop: 12 }} />
              </Blueprint>
            )}
            {pickError ? (
              <AppText variant="caption" tone="problem" style={{ marginTop: 8 }}>
                {pickError}
              </AppText>
            ) : null}
          </View>
        ) : null}

        {surveyId ? (
          <View>
            <SectionHeader title="4 · Upload" />
            {progress.state === "IDLE" ? (
              <>
                <Button label={mode === "images" ? `Upload ${files.length ? plural(files.length, "photo") : "photos"}` : "Import file"} onPress={start} disabled={!canUpload} fullWidth size="lg" />
                {mode === "images" && gcpFile && gcp.error ? (
                  <AppText variant="caption" tone="problem" style={{ marginTop: 8 }}>
                    Fix or remove the ground control points file first.
                  </AppText>
                ) : null}
              </>
            ) : (
              <UploadProgressCard
                progress={progress}
                onCancel={cancel}
                onRetry={start}
                onReset={() => {
                  reset();
                  setFiles([]);
                  setAssetFile(null);
                  setGcpFile(null);
                  setShowGcp(false);
                }}
                onOpenSurvey={() => router.push({ pathname: "/survey/[id]", params: { id: surveyId } })}
              />
            )}
            {progress.gcpError ? (
              <AppText variant="bodySm" tone="problem" style={{ marginTop: 10 }}>
                The ground control points file could not be used: {progress.gcpError} The photos were uploaded; you can add the points again on the flight screen.
              </AppText>
            ) : null}
          </View>
        ) : null}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: layout.pagePadding },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
});
