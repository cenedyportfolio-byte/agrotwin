import { formatWait, queueText } from "@/utils/queue";

describe("queue text", () => {
  it("rounds the wait the way people say it", () => {
    expect(formatWait(3)).toBe("5 min");
    expect(formatWait(42)).toBe("40 min");
    expect(formatWait(130)).toBe("about 2 h");
    expect(formatWait(14 * 60)).toBe("about 14 h");
    expect(formatWait(3 * 24 * 60)).toBe("about 3 days");
  });

  it("tells the farmer where the job is in line", () => {
    expect(queueText({ ahead: 0, wait_minutes: 0, hours: null, starts_at: null })).toBe("Yours is next in line — it starts in a moment.");
    expect(queueText({ ahead: 2, wait_minutes: 190, hours: null, starts_at: null })).toBe("2 maps are ahead of yours in line — yours should start in about 3 h.");
    expect(queueText({ ahead: 1, wait_minutes: null, hours: null, starts_at: null })).toBe("1 map is ahead of yours in line.");
    expect(queueText({ ahead: 0, wait_minutes: 300, hours: "8 pm–6 am", starts_at: "8 pm" })).toBe(
      "Detailed maps are made 8 pm–6 am, when the server is free: yours starts at 8 pm."
    );
    expect(queueText({ ahead: 2, wait_minutes: 1750, hours: "8 pm–6 am", starts_at: "8 pm" })).toBe(
      "Detailed maps are made 8 pm–6 am, when the server is free: 2 maps are ahead of yours; yours should start in about 29 h."
    );
  });
});
