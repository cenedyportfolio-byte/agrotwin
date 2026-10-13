"use client";

import Link from "next/link";
import { CheckCircle2, CloudSun, Grid3x3, Plane, Target, UploadCloud, XCircle } from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";

/** What a farmer needs to know to fly a field so it can be mapped. Kept short
 * enough to read on a phone at the edge of the field. */
export default function FlightGuidePage() {
  return (
    <AppShell>
      <div className="mx-auto max-w-2xl px-4 py-5 sm:px-6 sm:py-8 space-y-5">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold">How to fly your field</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            AgroTwin builds one map of your field from many overlapping photos taken straight down. These settings make
            a good map. Any drone with GPS works; a drone with a crop-health (multispectral) camera, such as the DJI
            Mavic 3 Multispectral, measures crop health more reliably than a regular camera.
          </p>
        </div>

        <Section icon={CloudSun} title="Before you fly">
          <Item>Fly between about 10 am and 2 pm, so shadows are short.</Item>
          <Item>
            Full sun or an evenly overcast sky are both fine. Avoid days with passing clouds: their shadows make the
            crop look patchy.
          </Item>
          <Item>Wind below about 15 mph, and no rain or dew on the leaves.</Item>
          <Item>
            Follow the FAA rules: flying for your farm business needs a Part 107 certificate and a registered drone.
            Stay below 400 ft, keep the drone in sight, and check the airspace (for example with the B4UFLY app).
          </Item>
          <Item>If your drone has a sunlight sensor on top, keep it clean and uncovered.</Item>
        </Section>

        <Section icon={Grid3x3} title="Flight settings">
          <p className="text-sm text-muted-foreground">
            Use a <strong className="text-foreground">mapping (grid) mission</strong> in your flight app — for example
            DJI Pilot 2 on Mavic 3 Enterprise / Multispectral drones, or a mapping app such as DroneDeploy or
            Pix4Dcapture (check that it supports your drone). Draw the field and set:
          </p>
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
            If you have black-and-white checkerboard targets, lay a few around the field edges and one in the middle.
            AgroTwin finds them by itself and uses them to check the map lines up. A flight without targets works too.
          </Item>
        </Section>

        <Section icon={UploadCloud} title="Uploading the photos">
          <Item>
            Take the memory card out of the drone. Each flight is one folder of photos (for DJI drones, inside{" "}
            <span className="font-mono text-xs">DCIM</span>).
          </Item>
          <Item>
            Upload <strong>all</strong> the photos of that flight in one go — from a computer, or from your phone with
            an SD card reader. On a phone, pick the files from the card in the <strong>Files</strong> app.
          </Item>
          <Dont>
            Don&apos;t use photos from your phone&apos;s gallery, or sent by text, WhatsApp or email: those copies can lose
            the GPS position the map needs.
          </Dont>
          <Dont>Don&apos;t crop, resize or edit the photos.</Dont>
          <Item>
            A flight is often several gigabytes: use Wi-Fi if you can, and keep the upload page open until it says
            done.
          </Item>
          <Item>First results usually appear within the hour. You can close the app meanwhile.</Item>
        </Section>

        <Link
          href="/upload"
          className="flex items-center justify-center gap-2 rounded-xl bg-brand px-4 py-3 text-sm font-semibold text-white"
        >
          <Plane size={16} /> Upload a flight
        </Link>
      </div>
    </AppShell>
  );
}

function Section({
  icon: Icon,
  title,
  children,
}: {
  icon: React.ComponentType<{ size?: number }>;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border bg-surface p-4 sm:p-5 space-y-3">
      <h2 className="flex items-center gap-2 font-semibold">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand/10 text-brand">
          <Icon size={17} />
        </span>
        {title}
      </h2>
      <div className="space-y-2.5">{children}</div>
    </section>
  );
}

function Item({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex gap-2 text-sm">
      <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-healthy" />
      <div>{children}</div>
    </div>
  );
}

function Dont({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex gap-2 text-sm">
      <XCircle size={16} className="mt-0.5 shrink-0 text-problem" />
      <div>{children}</div>
    </div>
  );
}

function Settings({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="divide-y divide-border rounded-lg border border-border text-sm">
      {rows.map(([k, v]) => (
        <div key={k} className="grid grid-cols-[7.5rem_1fr] gap-3 px-3 py-2">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="font-medium">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
