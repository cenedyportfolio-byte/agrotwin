import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { layout } from "@/constants/theme";
import { useRefresh } from "@/hooks/useRefresh";
import { useSurvey } from "@/features/surveys/hooks";
import { useProcessingJob, useRetryJob, useTriggerProcessing } from "@/features/processing/hooks";
import { jobKind } from "@/services/processing";
import { useUiStore } from "@/stores/uiStore";
import { Button, EmptyState, ErrorState, LoadingState, Screen, ScreenHeader, AppText } from "@/components/ui";
import { ProcessingHero, ProcessingSteps } from "@/components/processing/ProcessingProgress";

/** Canvas "Processing" screen: hero card, step list, footnote. Polls the backend job every 2 s while active. */
export default function ProcessingScreen() {
  const { surveyId } = useLocalSearchParams<{ surveyId: string }>();
  const router = useRouter();
  const setActiveSurvey = useUiStore((s) => s.setActiveSurvey);
  const survey = useSurvey(surveyId);
  const { job, active, isPending, isError, error, refetch } = useProcessingJob(surveyId);
  const process = useTriggerProcessing(surveyId ?? "");
  const retry = useRetryJob(surveyId ?? "", job);
  const { refreshing, onRefresh } = useRefresh(refetch, survey.refetch);

  useEffect(() => {
    if (surveyId) setActiveSurvey(surveyId);
  }, [surveyId, setActiveSurvey]);

  return (
    <Screen safeTop padded={false} refreshing={refreshing} onRefresh={onRefresh} bottomInset={layout.bottomClearance}>
      <ScreenHeader title="Making the map" subtitle={survey.data?.name} />
      <View style={styles.body}>
        {isPending ? (
          <LoadingState skeleton />
        ) : isError ? (
          <ErrorState error={error} onRetry={() => refetch()} />
        ) : !job ? (
          <EmptyState
            title="No map made yet"
            message={survey.data && survey.data.image_count > 0 ? "AgroTwin draws the field outline, builds the map and checks crop health." : "Upload the drone photos of this flight first."}
            actionLabel={survey.data && survey.data.image_count > 0 ? "Make the map" : undefined}
            onAction={survey.data && survey.data.image_count > 0 ? () => process.mutate() : undefined}
            secondaryLabel="Open the flight"
            onSecondary={() => surveyId && router.push({ pathname: "/survey/[id]", params: { id: surveyId } })}
          />
        ) : (
          <>
            <View style={{ marginBottom: 20 }}>
              <ProcessingHero job={job} surveyName={survey.data?.name} imageCount={survey.data?.image_count} />
            </View>
            <ProcessingSteps job={job} />
            {job.status === "FAILED" && retry ? <Button label="Try again" size="lg" onPress={() => retry.mutate()} loading={retry.isPending} fullWidth style={{ marginTop: 16 }} /> : null}
            {job.status === "COMPLETED" && surveyId ? (
              <Button label="View results" size="lg" onPress={() => router.replace({ pathname: "/analysis/[surveyId]", params: { surveyId } })} fullWidth style={{ marginTop: 16 }} />
            ) : null}
            <AppText variant="caption" tone="muted" style={{ marginTop: 16, textAlign: "center" }}>
              {active
                ? jobKind(job) === "detailed"
                  ? "The detailed map usually takes a few hours. This screen updates every few seconds."
                  : "Most flights are done within the hour. This screen updates every few seconds."
                : job.status === "COMPLETED"
                  ? "All steps finished."
                  : "Stopped."}
            </AppText>
          </>
        )}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({ body: { paddingHorizontal: layout.pagePadding } });
