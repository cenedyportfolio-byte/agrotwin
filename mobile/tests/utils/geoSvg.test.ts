import { boundsOf, fit } from "@/utils/geoSvg";
import { hourText } from "@/components/fields/SprayWeatherCard";
import { greenness } from "@/components/fields/SatelliteCard";

describe("outside data helpers", () => {
  it("fits a field into the drawing, north up", () => {
    const square = { type: "Polygon" as const, coordinates: [[[-85.59, 36.09], [-85.58, 36.09], [-85.58, 36.1], [-85.59, 36.1], [-85.59, 36.09]]] };
    const b = boundsOf([square]);
    expect(b).toEqual([-85.59, 36.09, -85.58, 36.1]);
    const { height, path } = fit(b!, 320, 6);
    // a degree of longitude is shorter than a degree of latitude here: taller than wide
    expect(height).toBeGreaterThan(320);
    expect(path(square).startsWith("M6.0 ")).toBe(true); // the north-west corner at the top left
    expect(path(square).endsWith("Z")).toBe(true);
  });

  it("words hours and greenness the way farmers say them", () => {
    expect([0, 7, 12, 18].map(hourText)).toEqual(["midnight", "7 am", "noon", "6 pm"]);
    expect(greenness(0.1)).toBe("bare soil or residue");
    expect(greenness(0.37)).toMatch(/^low/);
    expect(greenness(0.93)).toMatch(/full canopy/);
  });
});
