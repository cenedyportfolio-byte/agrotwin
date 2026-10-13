import { useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import { Leaf, Settings } from "lucide-react-native";
import { iconStroke, typography } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import { useAuth } from "@/providers/AuthProvider";
import { describeError } from "@/services/errors";
import { AppText, Button, Screen } from "@/components/ui";

/** Sign in with the e-mail and password the farmer got from their AgroTwin contact. */
export default function LoginScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const { signIn } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!email.trim() || !password) return setError("Enter your e-mail and password.");
    setBusy(true);
    setError(null);
    try {
      await signIn(email.trim(), password);
      router.replace("/(tabs)");
    } catch (err) {
      setError(describeError(err).message);
      setBusy(false);
    }
  };

  const inputStyle = [styles.input, typography.body, { color: colors.text, borderColor: colors.divider }];
  return (
    <Screen safeTop>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.body}>
        <View style={styles.brand}>
          <View style={[styles.logo, { backgroundColor: colors.accent }]}>
            <Leaf size={26} color="#fff" strokeWidth={iconStroke} />
          </View>
          <AppText variant="display">AgroTwin</AppText>
          <AppText variant="body" tone="muted">
            Your fields, seen from the air
          </AppText>
        </View>

        <View style={styles.field}>
          <AppText variant="caption" tone="muted">
            E-mail
          </AppText>
          <TextInput
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            autoComplete="email"
            keyboardType="email-address"
            textContentType="username"
            accessibilityLabel="E-mail"
            style={inputStyle}
          />
        </View>
        <View style={styles.field}>
          <AppText variant="caption" tone="muted">
            Password
          </AppText>
          <TextInput
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoComplete="password"
            textContentType="password"
            accessibilityLabel="Password"
            onSubmitEditing={submit}
            style={inputStyle}
          />
        </View>
        {error ? (
          <AppText variant="caption" tone="problem">
            {error}
          </AppText>
        ) : null}
        <Button label="Sign in" onPress={submit} loading={busy} disabled={busy} size="lg" fullWidth />

        <AppText variant="caption" tone="muted" style={styles.help}>
          No account, or forgot your password? Ask your AgroTwin contact at the university.
        </AppText>
        <Pressable onPress={() => router.push("/settings")} style={styles.server} accessibilityRole="button">
          <Settings size={14} color={colors.muted} strokeWidth={iconStroke} />
          <AppText variant="caption" tone="muted">
            Server address
          </AppText>
        </Pressable>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { flex: 1, justifyContent: "center", gap: 14, paddingTop: 48 },
  brand: { alignItems: "center", gap: 4, marginBottom: 20 },
  logo: { width: 52, height: 52, borderRadius: 14, alignItems: "center", justifyContent: "center", marginBottom: 8 },
  field: { gap: 4 },
  input: { height: 48, borderWidth: 1, paddingHorizontal: 12 },
  help: { textAlign: "center", marginTop: 8 },
  server: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 8 },
});
