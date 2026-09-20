import { fireEvent, render, screen } from "@testing-library/react-native";
import { TwinModeSelector } from "@/components/digitalTwin/TwinModeSelector";

describe("TwinModeSelector", () => {
  it("renders all 3 mode options: Map, 3D, and Realistic", async () => {
    const onSelect = jest.fn();
    await render(<TwinModeSelector mode="field-map" onSelectMode={onSelect} />);

    expect(screen.getByText("Map")).toBeTruthy();
    expect(screen.getByText("3D")).toBeTruthy();
    expect(screen.getByText("Realistic")).toBeTruthy();
  });

  it("triggers onSelectMode when a mode is tapped", async () => {
    const onSelect = jest.fn();
    await render(<TwinModeSelector mode="field-map" onSelectMode={onSelect} />);

    fireEvent.press(screen.getByText("3D"));
    expect(onSelect).toHaveBeenCalledWith("3d-twin");
  });
});
