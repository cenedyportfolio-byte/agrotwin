import { useState } from "react";
import { StyleSheet, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import { typography, layout } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import { useAuth } from "@/providers/AuthProvider";
import { describeError } from "@/services/errors";
import { AppText, Blueprint, Button, Screen, ScreenHeader } from "@/components/ui";

/** Deletes the account and everything AgroTwin keeps for it, after the
 * password and DELETE typed. Same as the website's Settings → Delete my account. */
export default function DeleteAccountScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const { user, deleteAccount } = useAuth();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = !!password && confirm.trim().toUpperCase() === "DELETE";

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      await deleteAccount(password, confirm);
      router.replace("/login");
    } catch (err) {
      setError(describeError(err).message);
      setBusy(false);
    }
  };

  const inputStyle = [styles.input, typography.body, { color: colors.text, borderColor: colors.divider }];
  return (
    <Screen safeTop padded={false} bottomInset={layout.bottomClearance}>
      <ScreenHeader title="Delete my account" subtitle={user?.email} />
      <View style={{ paddingHorizontal: layout.pagePadding, gap: 16 }}>
        <Blueprint style={{ gap: 8 }}>
          <AppText variant="bodyStrong" tone="problem">
            This cannot be undone.
          </AppText>
          <AppText variant="bodySm">
            Your account is deleted with everything AgroTwin keeps for it: your fields and their outlines, and every flight&apos;s uploaded photos, maps, 3D views and crop-health
            results.
          </AppText>
          <AppText variant="bodySm" tone="muted">
            Photos still on your drone&apos;s memory card or your phone are not touched.
          </AppText>
        </Blueprint>

        <View style={{ gap: 4 }}>
          <AppText variant="caption" tone="muted">
            Your password
          </AppText>
          <TextInput value={password} onChangeText={setPassword} secureTextEntry autoComplete="password" textContentType="password" accessibilityLabel="Password" style={inputStyle} />
        </View>
        <View style={{ gap: 4 }}>
          <AppText variant="caption" tone="muted">
            Type DELETE to confirm
          </AppText>
          <TextInput value={confirm} onChangeText={setConfirm} autoCapitalize="characters" autoCorrect={false} accessibilityLabel="Type DELETE to confirm" style={inputStyle} />
        </View>
        {error ? (
          <AppText variant="bodySm" tone="problem">
            {error}
          </AppText>
        ) : null}
        <Button label="Delete my account and data" variant="danger" size="lg" fullWidth onPress={submit} disabled={!ready} loading={busy} />
        <Button label="Keep my account" variant="secondary" fullWidth onPress={() => router.back()} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  input: { borderWidth: 1, minHeight: 48, paddingHorizontal: 12 },
});
