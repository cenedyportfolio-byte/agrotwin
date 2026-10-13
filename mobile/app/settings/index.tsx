import { useState } from "react";
import { StyleSheet, TextInput, View } from "react-native";
import Constants from "expo-constants";
import { Wifi } from "lucide-react-native";
import { env, isValidHttpUrl } from "@/constants/config";
import { iconStroke, layout, typography } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import { useTestConnection } from "@/features/settings/hooks";
import { describeError } from "@/services/errors";
import { effectiveUrls, useSettingsStore, type ThemePreference } from "@/stores/settingsStore";
import { Blueprint, Button, Chip, Disclosure, KeyValueRow, Screen, ScreenHeader, SectionHeader, StatusBadge, AppText } from "@/components/ui";

const THEMES: Array<{ key: ThemePreference; label: string }> = [
  { key: "system", label: "System" },
  { key: "light", label: "Light" },
  { key: "dark", label: "Dark" },
];

export default function SettingsScreen() {
  const { colors } = useTheme();
  const store = useSettingsStore();
  const urls = effectiveUrls(store);
  const [apiUrl, setApiUrl] = useState(store.apiUrl || env.apiUrl);
  const [webUrl, setWebUrl] = useState(store.webViewerUrl || env.webViewerUrl);
  const [saved, setSaved] = useState(false);
  const test = useTestConnection();

  const apiValid = apiUrl.trim() === "" || isValidHttpUrl(apiUrl);
  const webValid = webUrl.trim() === "" || isValidHttpUrl(webUrl);
  const localhost = /localhost|127\.0\.0\.1/i.test(`${apiUrl} ${webUrl}`);

  const save = () => {
    store.setApiUrl(apiUrl.trim() === env.apiUrl ? "" : apiUrl.trim());
    store.setWebViewerUrl(webUrl.trim() === env.webViewerUrl ? "" : webUrl.trim());
    setSaved(true);
    test.reset();
  };

  const resetToEnv = () => {
    store.resetServer();
    setApiUrl(env.apiUrl);
    setWebUrl(env.webViewerUrl);
    setSaved(true);
    test.reset();
  };

  const inputStyle = (valid: boolean) => [styles.input, typography.body, { color: colors.text, borderColor: valid ? colors.divider : colors.problem }];

  return (
    <Screen safeTop padded={false} bottomInset={layout.bottomClearance}>
      <ScreenHeader title="Settings" />
      <View style={styles.body}>
        <View style={{ marginBottom: 20 }}>
          <SectionHeader title="AgroTwin server" meta="The address your AgroTwin contact gave you" />
          <Blueprint>
            <AppText variant="caption" tone="muted">
              API address (FastAPI, port 8000)
            </AppText>
            <TextInput
              value={apiUrl}
              onChangeText={(t) => {
                setApiUrl(t);
                setSaved(false);
              }}
              placeholder="http://192.168.1.100:8000"
              placeholderTextColor={colors.muted}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              accessibilityLabel="API address"
              style={[inputStyle(apiValid), { marginTop: 4 }]}
            />
            <AppText variant="caption" tone="muted" style={{ marginTop: 12 }}>
              Web viewer address (Next.js, port 3000)
            </AppText>
            <TextInput
              value={webUrl}
              onChangeText={(t) => {
                setWebUrl(t);
                setSaved(false);
              }}
              placeholder="http://192.168.1.100:3000"
              placeholderTextColor={colors.muted}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              accessibilityLabel="Web viewer address"
              style={[inputStyle(webValid), { marginTop: 4 }]}
            />
            {!apiValid || !webValid ? (
              <AppText variant="caption" tone="problem" style={{ marginTop: 8 }}>
                Addresses must start with http:// or https://
              </AppText>
            ) : null}
            {localhost ? (
              <AppText variant="caption" tone="attention" style={{ marginTop: 8 }}>
                ⚠ "localhost" only works in a web browser on the computer itself. On the Android emulator use 10.0.2.2; on a phone use the computer's Wi-Fi IP address.
              </AppText>
            ) : null}
            <View style={styles.actions}>
              <Button label="Save" onPress={save} disabled={!apiValid || !webValid} />
              <Button label="Reset to defaults" variant="secondary" onPress={resetToEnv} disabled={!store.apiUrl && !store.webViewerUrl} />
            </View>
            {saved ? (
              <AppText variant="caption" tone="healthy" style={{ marginTop: 8 }}>
                Saved. Pull to refresh on any screen to reload data from the new server.
              </AppText>
            ) : null}
            <View style={[styles.actions, { marginTop: 12 }]}>
              <Button label="Test connection" variant="secondary" icon={<Wifi size={16} color={colors.text} strokeWidth={iconStroke} />} onPress={() => test.mutate()} loading={test.isPending} disabled={!urls.apiUrl} />
              {test.isSuccess ? <StatusBadge tier="healthy" label={`Connected · ${test.data.service}`} /> : null}
              {test.isError ? <StatusBadge tier="problem" label="Unreachable" /> : null}
            </View>
            {test.isError ? (
              <AppText variant="caption" tone="muted" style={{ marginTop: 8 }}>
                {describeError(test.error).message}
              </AppText>
            ) : null}
          </Blueprint>
        </View>

        <View style={{ marginBottom: 20 }}>
          <Disclosure showLabel="How to find the right address" hideLabel="Hide address help">
            <KeyValueRow label="University server" value="https://<its address> in both boxes" mono />
            <AppText variant="caption" tone="muted" style={{ marginTop: 8, marginBottom: 8 }}>
              For development on a laptop instead:
            </AppText>
            <KeyValueRow label="Android Emulator" value="http://10.0.2.2:8000" mono />
            <KeyValueRow label="Physical phone" value="http://<laptop LAN IP>:8000" mono />
            <KeyValueRow label="Laptop LAN IP" value="ipconfig (Windows) / ip addr (Linux)" />
            <KeyValueRow label="Backend must listen on" value="0.0.0.0, not 127.0.0.1" last />
            <AppText variant="caption" tone="muted" style={{ marginTop: 8 }}>
              On a laptop both devices need the same Wi-Fi network and the firewall must allow ports 8000 and 3000. Details in mobile/README.md.
            </AppText>
          </Disclosure>
        </View>

        <View style={{ marginBottom: 20 }}>
          <SectionHeader title="Appearance" />
          <Blueprint>
            <AppText variant="caption" tone="muted" style={{ marginBottom: 8 }}>
              Theme
            </AppText>
            <View style={styles.chips}>
              {THEMES.map((t) => (
                <Chip key={t.key} label={t.label} selected={store.theme === t.key} onPress={() => store.setTheme(t.key)} />
              ))}
            </View>
            <AppText variant="caption" tone="muted" style={{ marginTop: 16, marginBottom: 8 }}>
              Detail level
            </AppText>
            <View style={styles.chips}>
              <Chip label="Simple" selected={!store.advancedMode} onPress={() => store.setAdvancedMode(false)} />
              <Chip label="Advanced" selected={store.advancedMode} onPress={() => store.setAdvancedMode(true)} />
            </View>
          </Blueprint>
        </View>

        <View>
          <SectionHeader title="About" />
          <Blueprint>
            <KeyValueRow label="App version" value={Constants.expoConfig?.version ?? "dev"} />
            <KeyValueRow label="Environment" value={env.environment} />
            <KeyValueRow label="Built-in API address" value={env.apiUrl || "not set in .env"} mono />
            <KeyValueRow label="Built-in web address" value={env.webViewerUrl || "not set in .env"} mono last />
          </Blueprint>
        </View>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: layout.pagePadding },
  input: { height: 48, borderWidth: 1, paddingHorizontal: 12 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 16, alignItems: "center" },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
});
