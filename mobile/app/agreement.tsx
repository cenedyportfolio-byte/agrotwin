import { useState } from "react";
import { StyleSheet, Switch, View } from "react-native";
import { useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { FileText } from "lucide-react-native";
import { iconStroke, layout } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import { queryKeys } from "@/features/queryKeys";
import { useAuth } from "@/providers/AuthProvider";
import { authService } from "@/services/auth";
import { describeError } from "@/services/errors";
import { formatDate } from "@/utils/format";
import { AgreementText } from "@/components/account/AgreementText";
import { AppText, Blueprint, Button, ErrorState, LoadingState, Screen, ScreenHeader } from "@/components/ui";

/** The data agreement: read, agree, then into the app. A farmer who has not
 * accepted it (or its new version) is kept here by the sign-in gate; anyone
 * can read it again from Profile. */
export default function AgreementScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const { needsAgreement, acceptAgreement, signOut } = useAuth();
  const agreement = useQuery({ queryKey: queryKeys.agreement, queryFn: authService.agreement });
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const a = agreement.data;

  const accept = async () => {
    if (!a) return;
    setBusy(true);
    setError(null);
    try {
      await acceptAgreement(a.version);
      router.replace("/(tabs)");
    } catch (err) {
      setError(describeError(err).message);
      agreement.refetch(); // it may have changed meanwhile: show the new text
      setBusy(false);
    }
  };

  return (
    <Screen safeTop padded={false} bottomInset={layout.bottomClearance}>
      {needsAgreement ? (
        <View style={[styles.brand, { paddingHorizontal: layout.pagePadding }]}>
          <FileText size={20} color={colors.accent} strokeWidth={iconStroke} />
          <AppText variant="title">Data agreement</AppText>
        </View>
      ) : (
        <ScreenHeader title="Data agreement" />
      )}
      <View style={{ paddingHorizontal: layout.pagePadding, gap: 16 }}>
        {agreement.isPending ? (
          <LoadingState message="Loading the agreement…" />
        ) : agreement.isError ? (
          <ErrorState error={agreement.error} title="Unable to load the agreement" onRetry={() => agreement.refetch()} />
        ) : !a ? (
          <AppText variant="body" tone="muted">
            There is no data agreement on this AgroTwin server.
          </AppText>
        ) : (
          <>
            <View style={{ gap: 4 }}>
              <AppText variant="cardTitle">{a.title}</AppText>
              <AppText variant="bodySm" tone="muted">
                {a.accepted && a.accepted_at
                  ? `You agreed to this on ${formatDate(a.accepted_at)}.`
                  : "Before you use AgroTwin, read how your fields' photos and maps are used and kept. If it changes, you are asked again."}
              </AppText>
            </View>
            <Blueprint plain>
              <AgreementText text={a.text} />
            </Blueprint>
            {!a.accepted ? (
              <>
                <View style={styles.row}>
                  <Switch value={agreed} onValueChange={setAgreed} trackColor={{ true: colors.accent }} accessibilityLabel="I have read the agreement and I agree to it" />
                  <AppText variant="bodyStrong" style={{ flex: 1 }}>
                    I have read the agreement and I agree to it.
                  </AppText>
                </View>
                {error ? (
                  <AppText variant="bodySm" tone="problem">
                    {error}
                  </AppText>
                ) : null}
                <Button label="Agree and continue" size="lg" fullWidth onPress={accept} disabled={!agreed} loading={busy} />
                <Button label="Sign out" variant="secondary" fullWidth onPress={() => void signOut().then(() => router.replace("/login"))} />
                <AppText variant="caption" tone="muted">
                  Questions about the agreement or your data? Ask your AgroTwin contact. You can delete your account and all its data at any time under Profile.
                </AppText>
              </>
            ) : null}
          </>
        )}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  brand: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 16, marginTop: 8 },
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
});
