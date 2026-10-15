import { render, screen } from "@testing-library/react-native";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { HealthLegendRows } from "@/components/ui/HealthIndicator";
import { DetectionZoneCard } from "@/components/analysis/DetectionZoneCard";
import { ProcessingProgress } from "@/components/processing/ProcessingProgress";
import type { DetectionZone, ProcessingJob } from "@/types";

const zone: DetectionZone = {
  id: "z1",
  type: "patchy_vegetation",
  severity: "medium",
  confidence: 0.64,
  geometry: { type: "Polygon", coordinates: [[[0, 0], [0.0001, 0], [0.0001, 0.0001], [0, 0.0001], [0, 0]]] },
  recommended_action: "Ground inspection recommended",
};

describe("status labels never rely on colour alone", () => {
  it("StatusBadge always renders a text label", async () => {
    await render(<StatusBadge tier="attention" />);
    expect(screen.getByText("Needs attention")).toBeTruthy();
  });

  it("HealthLegendRows prints all three measured shares with their labels", async () => {
    await render(<HealthLegendRows shares={{ healthy: 66, attention: 32.2, problem: 1.7 }} />);
    expect(screen.getByText("66%")).toBeTruthy();
    expect(screen.getByText("32.2%")).toBeTruthy();
    expect(screen.getByText("1.7%")).toBeTruthy();
    expect(screen.getByText("healthy")).toBeTruthy();
    expect(screen.getByText("needs attention")).toBeTruthy();
    expect(screen.getByText("problem")).toBeTruthy();
  });
});

describe("DetectionZoneCard", () => {
  it("translates the backend type into farmer language with priority and recommendation", async () => {
    const onViewOnMap = jest.fn();
    await render(<DetectionZoneCard zone={zone} areaM2={320} locationLabel="North-West area" onViewOnMap={onViewOnMap} />);
    expect(screen.getByText(/Patchy vegetation/)).toBeTruthy();
    expect(screen.getByText("Medium")).toBeTruthy();
    expect(screen.getByText("North-West area · 0.08 acres")).toBeTruthy();
    expect(screen.getByText("Ground inspection recommended")).toBeTruthy();
    expect(screen.queryByText(/patchy_vegetation/)).toBeNull();
  });
  it("shows the raw type only in advanced mode", async () => {
    const onViewOnMap = jest.fn();
    await render(<DetectionZoneCard zone={zone} advanced onViewOnMap={onViewOnMap} />);
    expect(screen.getByText(/patchy_vegetation/)).toBeTruthy();
  });
});

describe("ProcessingProgress", () => {
  const job: ProcessingJob = {
    id: "j1",
    survey_id: "s1",
    status: "GENERATING_ORTHOMOSAIC",
    current_step: "generating_orthomosaic",
    steps: [
      { key: "images_uploaded", label: "Images Uploaded", status: "complete" },
      { key: "metadata_extracted", label: "Metadata Extracted", status: "complete" },
      { key: "processing_field", label: "Processing Field", status: "complete" },
      { key: "generating_orthomosaic", label: "Generating Orthomosaic", status: "pending" },
      { key: "ai_analysis", label: "AI Analysis", status: "pending" },
      { key: "digital_twin_ready", label: "Digital Twin Ready", status: "pending" },
    ],
    error_message: null,
    created_at: null,
    updated_at: null,
  };
  it("lists the backend's steps and marks the current one", async () => {
    await render(<ProcessingProgress job={job} />);
    expect(screen.getByText("Making your field map")).toBeTruthy();
    // "Generating Orthomosaic" appears twice: the hero's current-step line and its own row in the step list.
    expect(screen.getAllByText("Generating Orthomosaic").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("Working")).toBeTruthy();
    expect(screen.getByText("AI Analysis")).toBeTruthy();
  });
  it("shows the failure message and a retry button", async () => {
    const onRetry = jest.fn();
    await render(<ProcessingProgress job={{ ...job, status: "FAILED", error_message: "rasterio missing" }} onRetry={onRetry} />);
    expect(screen.getByText("rasterio missing")).toBeTruthy();
    expect(screen.getByText("Try again")).toBeTruthy();
  });
  it("names the detailed map, says it takes hours, and shows the note of a long step", async () => {
    const detailed: ProcessingJob = {
      ...job,
      status: "PROCESSING",
      current_step: "odm_reconstruction",
      steps: [
        { key: "odm_prepare", label: "Getting the photos ready", status: "complete" },
        { key: "odm_reconstruction", label: "3D reconstruction of the field (the long part)", status: "pending", note: "matching the photos, stage 4 of 13" },
        { key: "odm_import", label: "Drawing the detailed map", status: "pending" },
      ],
    };
    await render(<ProcessingProgress job={detailed} />);
    expect(screen.getByText("Making the detailed map")).toBeTruthy();
    expect(screen.getByText(/Usually a few hours/)).toBeTruthy();
    expect(screen.getAllByText("matching the photos, stage 4 of 13").length).toBeGreaterThanOrEqual(1);
  });
  it("says the quick map is still there when the detailed map fails", async () => {
    const failed: ProcessingJob = {
      ...job,
      status: "FAILED",
      current_step: "odm_reconstruction",
      error_message: "Not enough overlap between the photos.",
      steps: [{ key: "odm_prepare", label: "Getting the photos ready", status: "complete" }, { key: "odm_reconstruction", label: "3D reconstruction", status: "failed" }],
    };
    await render(<ProcessingProgress job={failed} />);
    expect(screen.getByText("The detailed map could not be made")).toBeTruthy();
    expect(screen.getByText("Not enough overlap between the photos. The quick map is still there.")).toBeTruthy();
  });
});
