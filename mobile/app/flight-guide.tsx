import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";
import { CircleCheck, CloudSun, Grid3x3, Target, CloudUpload, CircleX, type LucideIcon } from "lucide-react-native";
import { iconStroke, layout } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import { AppText, Blueprint, Button, IconBox, Screen, ScreenHeader } from "@/components/ui";

/** What a farmer needs to know to fly a field so it can be mapped — the
 * website's flight guide, short enough to read at the edge of the field. */
export default function FlightGuideScreen() {
  const router = useRouter();
  return (
    <Screen safeTop padded={false} bottomInset={layout.bottomClearance}>
      <ScreenHeader title="How to fly your field" />
      <View style={styles.body}>
        <AppText variant="bodySm" tone="muted">
          AgroTwin builds one map of your field from many overlapping photos taken straight down. These settings make a good map. Any drone with GPS works; a drone with a
          crop-health (multispectral) camera, such as the DJI Mavic 3 Multispectral, measures crop health more reliably than a regular camera.
        </AppText>

        <Section icon={CloudSun} title="Before you fly">
          <Item>Fly between about 10 am and 2 pm, so shadows are short.</Item>
          <Item>Full sun or an evenly overcast sky are both fine. Avoid days with passing clouds: their shadows make the crop look patchy.</Item>
          <Item>Wind below about 15 mph, and no rain or dew on the leaves.</Item>
          <Item>
            Follow the FAA rules: flying for your farm business needs a Part 107 certificate and a registered drone. Stay below 400 ft, keep the drone in sight, and check
            the airspace (for example with the B4UFLY app).
          </Item>
          <Item>If your drone has a sunlight sensor on top, keep it clean and uncovered.</Item>
        </Section>

        <Section icon={Grid3x3} title="Flight settings">
          <AppText variant="bodySm" tone="muted">
            Use a mapping (grid) mission in your flight app — for example DJI Pilot 2 on Mavic 3 Enterprise / Multispectral drones, or a mapping app such as DroneDeploy or
            Pix4Dcapture (check that it supports your drone). Draw the field and set:
          </AppText>
          <Settings
            rows={[
              ["Height", "100 ft (30 m) above the field — shows single plants. Up to 200 ft is fine for big fields."],
              ["Front overlap", "80%"],
              ["Side overlap", "75%"],
              ["Camera angle", "Straight down (−90°)"],
              ["Area", "The whole field, plus one pass beyond each edge"],
              ["Speed", "Let the app choose — it keeps the photos sharp"],
              ["Photos", "Keep the drone's normal JPG (and TIF band images on a multispectral drone)"],
            ]}
          />
        </Section>

        <Section icon={Target} title="Ground targets (optional)">
          <Item>
            If you have black-and-white checkerboard targets, lay a few around the field edges and one in the middle. AgroTwin finds them by itself and uses them to check
            the map lines up. A flight without targets works too.
          </Item>
          <Item>
            If you measured the targets with a GPS, add that file with the photos (“Ground control points” on the upload screen): a CSV from your GPS, or OpenDroneMap’s
            gcp_list.txt. Points measured with an RTK GPS line the detailed map up to the inch — especially useful for a drone without RTK, whose map can be several feet
            off. Handheld GPS points are only compared.
          </Item>
        </Section>

        <Section icon={CloudUpload} title="Uploading the photos">
          <Item>Take the memory card out of the drone. Each flight is one folder of photos (for DJI drones, inside DCIM).</Item>
          <Item>
            Upload all the photos of that flight in one go — from a computer, or from your phone with an SD card reader. On a phone, use “Choose files” and pick them from
            the card.
          </Item>
          <Dont>Don’t use photos from your phone’s gallery, or sent by text, WhatsApp or email: those copies can lose the GPS position the map needs.</Dont>
          <Dont>Don’t crop, resize or edit the photos.</Dont>
          <Item>A flight is often several gigabytes: use Wi-Fi if you can, and keep the upload screen open until it says done. Very large flights go faster from a computer.</Item>
          <Item>First results usually appear within the hour. You can close the app meanwhile.</Item>
        </Section>

        <Button label="Upload a flight" size="lg" fullWidth onPress={() => router.push("/upload")} style={{ marginTop: 4 }} />
      </View>
    </Screen>
  );
}

function Section({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children: ReactNode }) {
  const { colors } = useTheme();
  return (
    <Blueprint style={{ gap: 12 }}>
      <View style={styles.sectionHead}>
        <IconBox size={34}>
          <Icon size={18} color={colors.accent} strokeWidth={iconStroke} />
        </IconBox>
        <AppText variant="heading">{title}</AppText>
      </View>
      {children}
    </Blueprint>
  );
}

function Item({ children }: { children: ReactNode }) {
  const { colors } = useTheme();
  return (
    <View style={styles.item}>
      <CircleCheck size={16} color={colors.healthy} strokeWidth={1.8} style={styles.itemIcon} />
      <AppText variant="bodySm" style={{ flex: 1 }}>
        {children}
      </AppText>
    </View>
  );
}

function Dont({ children }: { children: ReactNode }) {
  const { colors } = useTheme();
  return (
    <View style={styles.item}>
      <CircleX size={16} color={colors.problem} strokeWidth={1.8} style={styles.itemIcon} />
      <AppText variant="bodySm" style={{ flex: 1 }}>
        {children}
      </AppText>
    </View>
  );
}

function Settings({ rows }: { rows: [string, string][] }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.settings, { borderColor: colors.divider }]}>
      {rows.map(([k, v], i) => (
        <View key={k} style={[styles.setting, i > 0 && { borderTopWidth: 1, borderTopColor: colors.hairline }]}>
          <AppText variant="caption" tone="muted" style={{ width: 96 }}>
            {k}
          </AppText>
          <AppText variant="bodySmStrong" style={{ flex: 1 }}>
            {v}
          </AppText>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: layout.pagePadding, gap: 16 },
  sectionHead: { flexDirection: "row", alignItems: "center", gap: 10 },
  item: { flexDirection: "row", gap: 8, alignItems: "flex-start" },
  itemIcon: { marginTop: 2 },
  settings: { borderWidth: 1 },
  setting: { flexDirection: "row", gap: 10, paddingHorizontal: 12, paddingVertical: 9 },
});
