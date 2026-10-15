import { fieldsService } from "@/services/fields";
import { setBaseUrls } from "@/services/runtimeConfig";
import { FakeXhr, fields } from "../mocks/fakeXhr";

describe("fieldsService flight plan", () => {
  const fetchMock = jest.fn();
  const kmz = { uri: "file:///cache/ditty_road.kmz", name: "ditty_road.kmz", type: "application/vnd.google-earth.kmz" };
  const field = { id: "f1", name: "Ditty Road", area_hectares: 4, boundary_source: "flight_plan", boundary_file: "ditty_road.kmz" };

  beforeEach(() => {
    fetchMock.mockReset();
    FakeXhr.sent = [];
    FakeXhr.reply = { status: 200, body: { field, kind: "DJI mapping mission", notes: [], rechecking: 1 } };
    global.fetch = fetchMock as unknown as typeof fetch;
    (global as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest = FakeXhr;
    setBaseUrls({ apiUrl: "http://10.0.2.2:8000", webViewerUrl: "http://10.0.2.2:3000" });
  });

  it("sends the KMZ as the field's outline", async () => {
    await expect(fieldsService.attachFlightPlan("f1", kmz)).resolves.toMatchObject({ field: { boundary_source: "flight_plan" }, rechecking: 1 });
    const req = FakeXhr.sent[0]!;
    expect(req.method).toBe("POST");
    expect(req.url).toBe("http://10.0.2.2:8000/api/fields/f1/boundary-file");
    expect(fields(req.body)).toEqual({ file: "<file>" });
  });

  it("passes the server's reason when the file is not an outline", async () => {
    FakeXhr.reply = { status: 422, body: { detail: "This flight plan is a waypoint route, not an area." } };
    await expect(fieldsService.attachFlightPlan("f1", kmz)).rejects.toMatchObject({ status: 422, message: "This flight plan is a waypoint route, not an area." });
  });

  it("goes back to the photo outline", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ field: { ...field, boundary_source: null, boundary_file: null }, kind: null, notes: [], rechecking: 0 }), { status: 200 }));
    await expect(fieldsService.removeFlightPlan("f1")).resolves.toMatchObject({ field: { boundary_source: null } });
    expect(fetchMock.mock.calls[0][0]).toBe("http://10.0.2.2:8000/api/fields/f1/boundary-file");
    expect(fetchMock.mock.calls[0][1].method).toBe("DELETE");
  });
});
