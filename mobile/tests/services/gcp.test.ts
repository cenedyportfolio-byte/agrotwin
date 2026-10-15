import { gcpService } from "@/services/gcp";
import { setBaseUrls } from "@/services/runtimeConfig";

/** The multipart fields as a plain object. The file part is only marked as
 * present: React Native sends {uri, name, type}, which Node's FormData (used
 * under jest) turns into a string. */
function fields(body: FormData): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  body.forEach((v, k) => {
    out[k] = k === "file" ? "<file>" : v;
  });
  return out;
}

/** GCP files go up with XMLHttpRequest, like the photos (React Native's fetch
 * fails on Android for a multipart body holding a picked file). */
class FakeXhr {
  static sent: { method: string; url: string; body: FormData; headers: Record<string, string> }[] = [];
  static reply: { status: number; body: unknown } = { status: 200, body: {} };
  status = 0;
  responseText = "";
  timeout = 0;
  upload: { onprogress: ((e: unknown) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  private method = "";
  private url = "";
  private headers: Record<string, string> = {};
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(k: string, v: string) {
    this.headers[k] = v;
  }
  abort() {}
  send(body: FormData) {
    FakeXhr.sent.push({ method: this.method, url: this.url, body, headers: this.headers });
    this.status = FakeXhr.reply.status;
    this.responseText = JSON.stringify(FakeXhr.reply.body);
    setTimeout(() => this.onload?.(), 0);
  }
}

describe("gcpService", () => {
  const fetchMock = jest.fn();
  const file = { uri: "file:///cache/points.csv", name: "points.csv", type: "text/csv" };
  const info = { format: "csv-latlon", crs: "EPSG:4326", rtk: false, notes: [], odm_observations: 0, points: [{ name: "GCP1", lat: 36, lon: -85, elevation_m: null }] };

  beforeEach(() => {
    fetchMock.mockReset();
    FakeXhr.sent = [];
    FakeXhr.reply = { status: 200, body: info };
    global.fetch = fetchMock as unknown as typeof fetch;
    (global as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest = FakeXhr;
    setBaseUrls({ apiUrl: "http://10.0.2.2:8000", webViewerUrl: "http://10.0.2.2:3000" });
  });

  it("checks a file before the flight exists, compared with the chosen field", async () => {
    await expect(gcpService.checkFile(file, { epsg: " 6576 ", fieldId: "f1" })).resolves.toMatchObject({ format: "csv-latlon" });
    const req = FakeXhr.sent[0]!;
    expect(req.method).toBe("POST");
    expect(req.url).toBe("http://10.0.2.2:8000/api/surveys/gcp-file/check");
    expect(fields(req.body)).toEqual({ file: "<file>", epsg: "6576", field_id: "f1" });
  });

  it("attaches a file with the RTK answer, or only reads it on a dry run", async () => {
    await gcpService.uploadFile("s1", file, { rtk: true, epsg: "" });
    await gcpService.uploadFile("s1", file, { rtk: false, dryRun: true });
    const [attach, dryRun] = FakeXhr.sent;
    expect(attach?.url).toBe("http://10.0.2.2:8000/api/surveys/s1/gcp-file");
    expect(fields(attach!.body)).toEqual({ file: "<file>", rtk: "true", dry_run: "false" });
    expect(fields(dryRun!.body)).toEqual({ file: "<file>", rtk: "false", dry_run: "true" });
  });

  it("passes the server's reason when a file cannot be used", async () => {
    FakeXhr.reply = { status: 422, body: { detail: "The points are 40 miles from this field" } };
    await expect(gcpService.uploadFile("s1", file, { rtk: true })).rejects.toMatchObject({ status: 422, message: "The points are 40 miles from this field" });
  });

  it("reads the comparison and removes the file", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ file: null, report: null }), { status: 200 }));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ deleted: true, queued: false }), { status: 200 }));
    await expect(gcpService.check("s1")).resolves.toEqual({ file: null, report: null });
    await expect(gcpService.deleteFile("s1")).resolves.toEqual({ deleted: true, queued: false });
    expect(fetchMock.mock.calls[1][0]).toBe("http://10.0.2.2:8000/api/surveys/s1/gcp-file");
    expect(fetchMock.mock.calls[1][1].method).toBe("DELETE");
  });
});
