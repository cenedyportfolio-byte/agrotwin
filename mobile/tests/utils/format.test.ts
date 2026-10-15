import { cropLabel, formatAcres, formatArea, formatDate, formatDistance, formatFeet, formatFieldArea, formatNumber, formatPercent, formatTargetSize, greeting, plural, seasonOf } from "@/utils/format";

describe("format utils", () => {
  it("formats numbers with separators", () => {
    expect(formatNumber(1378)).toBe("1,378");
    expect(formatNumber(null)).toBe("—");
  });
  it("formats percentages honestly (one decimal only when needed)", () => {
    expect(formatPercent(66)).toBe("66%");
    expect(formatPercent(32.2)).toBe("32.2%");
    expect(formatPercent(1.7)).toBe("1.7%");
  });
  it("formats areas in acres, as US farmers read them", () => {
    expect(formatArea(320)).toBe("0.08 acres");
    expect(formatArea(12270)).toBe("3.0 acres");
    expect(formatArea(10)).toBe("under 0.01 acres");
    expect(formatFieldArea(16.19)).toBe("40 acres");
    expect(formatAcres(1)).toBe("1.0 acre");
    expect(formatAcres(null)).toBe("—");
  });
  it("formats heights in feet and short distances in inches or feet", () => {
    expect(formatFeet(30)).toBe("98 ft");
    expect(formatDistance(0.02)).toBe("0.8 in");
    expect(formatDistance(1.442)).toBe("4.7 ft");
    expect(formatDistance(null)).toBe("—");
  });
  it("gives a ground target's sides and area", () => {
    expect(formatTargetSize(0.6)).toBe("60 × 60 cm · 0.36 m²");
    expect(formatTargetSize(0.597)).toBe("60 × 60 cm · 0.36 m²");
    expect(formatTargetSize(0.17)).toBe("17 × 17 cm · 289 cm²");
  });
  it("formats dates and seasons", () => {
    expect(formatDate("2026-06-03T15:03:19")).toBe("June 3, 2026");
    expect(seasonOf("2026-06-03T15:03:19")).toBe("2026 Season");
    expect(formatDate(null)).toBe("Unknown date");
  });
  it("labels crops and plurals", () => {
    expect(cropLabel("soybean")).toBe("Soybean");
    expect(plural(1, "file")).toBe("1 file");
    expect(plural(2, "file")).toBe("2 files");
  });
  it("greets by time of day", () => {
    expect(greeting(new Date(2026, 8, 14, 8))).toBe("Good morning");
    expect(greeting(new Date(2026, 8, 14, 20))).toBe("Good evening");
  });
});
