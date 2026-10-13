import { useEffect, useMemo, useState } from "react";
import { StyleSheet, Switch, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { FileUp, ImagePlus, Monitor } from "lucide-react-native";
import { mobileUploadSoftLimit } from "@/constants/config";
import { iconStroke, layout } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import { useCreateField, useFields } from "@/features/fields/hooks";
import { useCreateSurvey, useSurveys } from "@/features/surveys/hooks";
import { pickAssetFile, pickDroneImages, pickImageFiles } from "@/features/upload/pickers";
import { useUploadFlow } from "@/features/upload/useUploadFlow";
import { IMPORTABLE_ASSET_TYPES, type ImportableAssetType } from "@/services/assets";
import { describeError } from "@/services/errors";
import type { LocalFile } from "@/services/surveys";
import { formatDate, formatNumber, plural } from "@/utils/format";
import { Blueprint, Button, Chip, ErrorState, LoadingState, Screen, ScreenHeader, SectionHeader, AppText } from "@/components/ui";
import { NewFieldForm } from "@/components/upload/NewFieldForm";
import { NewSurveyForm } from "@/components/upload/NewSurveyForm";
import { UploadProgressCard } from "@/components/upload/UploadProgressCard";

type Mode = "images" | "asset";

export default function UploadScreen() {
  const params = useLocalSearchParams<{ fieldId?: string; surveyId?: string }>();
  const router = useRouter();
  const { colors } = useTheme();

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
    if (mode === "images") void uploadImages(files, startProcessing);
    else if (assetFile) void uploadAsset(assetType, assetFile);
  };

  if (fields.isPending || surveys.isPending) {
    return (
      <Screen safeTop padded={false}>
        <ScreenHeader title="New survey" />
        <View style={styles.body}>
          <LoadingState cards={2} />
        </View>
      </Screen>
    );
  }
  if (fields.isError) {
    return (
      <Screen safeTop padded={false}>
        <ScreenHeader title="New survey" />
        <ErrorState error={fields.error} onRetry={() => fields.refetch()} />
      </Screen>
    );
  }

  const canUpload = !!surveyId && !busy && (mode === "images" ? files.length > 0 : !!assetFile);

  return (
    <Screen safeTop padded={false} bottomInset={layout.bottomClearance}>
      <ScreenHeader title="New survey" subtitle={`Step ${surveyId ? 4 : fieldId ? 2 : 1} of 4`} />
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
            <SectionHeader title="2 · Survey" actionLabel={newSurvey ? "Choose existing" : "New survey"} onAction={() => setNewSurvey((v) => !v)} />
            {newSurvey || openSurveys.length === 0 ? (
              <Blueprint>
                {openSurveys.length === 0 && !newSurvey ? (
                  <AppText variant="caption" tone="muted" style={{ marginBottom: 12 }}>
                    This field has no surveys yet — create the first one.
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
            <SectionHeader title="3 · What to upload" />
            <View style={[styles.chips, { marginBottom: 12 }]}>
              <Chip label="Drone images" selected={mode === "images"} onPress={() => setMode("images")} disabled={busy} />
              <Chip label="Processed file" selected={mode === "asset"} onPress={() => setMode("asset")} disabled={busy} />
            </View>
            {mode === "images" ? (
              <Blueprint>
                <AppText variant="caption" tone="muted">
                  JPG or TIFF drone frames with GPS. Files already on the server (same name and size) are skipped, so you can retry safely.
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
                        ⚠ {formatNumber(files.length)} files is a lot for a phone upload. For large drone surveys, upload from the AgroTwin web application or desktop
                        processing workflow.
                      </AppText>
                    ) : null}
                    <Button label="Clear selection" variant="ghost" align="start" size="sm" onPress={() => setFiles([])} disabled={busy} />
                  </View>
                ) : null}
                <View style={[styles.row, { marginTop: 12 }]}>
                  <Switch value={startProcessing} onValueChange={setStartProcessing} disabled={busy} trackColor={{ true: colors.accent }} accessibilityLabel="Start processing after upload" />
                  <AppText variant="body" style={{ flex: 1 }}>
                    Start processing after upload
                  </AppText>
                </View>
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
              <Button label={mode === "images" ? `Upload ${files.length ? plural(files.length, "image") : "images"}` : "Import file"} onPress={start} disabled={!canUpload} fullWidth size="lg" />
            ) : (
              <UploadProgressCard
                progress={progress}
                onCancel={cancel}
                onRetry={start}
                onReset={() => {
                  reset();
                  setFiles([]);
                  setAssetFile(null);
                }}
                onOpenSurvey={() => router.push({ pathname: "/survey/[id]", params: { id: surveyId } })}
              />
            )}
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
