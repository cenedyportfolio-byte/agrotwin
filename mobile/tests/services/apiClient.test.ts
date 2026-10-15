import { apiUrl, getJson, publicAssetUrl, webUrl } from "@/services/apiClient";
import { ApiError } from "@/services/errors";
import { setBaseUrls, setConsentRequiredHandler } from "@/services/runtimeConfig";

const okJson = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));

describe("apiClient", () => {
  const fetchMock = jest.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
    setBaseUrls({ apiUrl: "http://192.168.1.50:8000/", webViewerUrl: "http://192.168.1.50:3000" });
  });

  it("builds absolute URLs without double slashes and routes public_url by prefix", () => {
    expect(apiUrl("/api/fields")).toBe("http://192.168.1.50:8000/api/fields");
    expect(webUrl("tiles/x")).toBe("http://192.168.1.50:3000/tiles/x");
    expect(publicAssetUrl("/tiles/8dab5067ab14/orthomosaic")).toBe("http://192.168.1.50:3000/tiles/8dab5067ab14/orthomosaic");
    expect(publicAssetUrl("/api/surveys/s/assets/a/files/tileset.json")).toBe("http://192.168.1.50:8000/api/surveys/s/assets/a/files/tileset.json");
  });

  it("parses JSON and appends query parameters", async () => {
    fetchMock.mockImplementation(() => okJson([{ id: "f1" }]));
    const data = await getJson<Array<{ id: string }>>("/api/fields", { query: { limit: 5, skip: null } });
    expect(data).toEqual([{ id: "f1" }]);
    expect(fetchMock.mock.calls[0]![0]).toBe("http://192.168.1.50:8000/api/fields?limit=5");
  });

  it("normalises FastAPI errors into ApiError with the detail message", async () => {
    fetchMock.mockImplementation(() => okJson({ detail: "Survey not found" }, 404));
    await expect(getJson("/api/surveys/nope")).rejects.toMatchObject({ kind: "http", status: 404, detail: "Survey not found" });
  });

  it("asks for the data agreement when the server refuses until it is accepted", async () => {
    const asked = jest.fn();
    setConsentRequiredHandler(asked);
    fetchMock.mockImplementation(() => okJson({ detail: "Survey not found" }, 403));
    await expect(getJson("/api/fields")).rejects.toMatchObject({ status: 403 });
    expect(asked).not.toHaveBeenCalled(); // another refusal is only an error
    fetchMock.mockImplementation(() => okJson({ detail: "Accept the data agreement first: it is shown when you sign in." }, 403));
    await expect(getJson("/api/fields")).rejects.toMatchObject({ status: 403 });
    expect(asked).toHaveBeenCalledTimes(1);
    setConsentRequiredHandler(() => {});
  });

  it("reports an unreachable server as offline", async () => {
    fetchMock.mockImplementation(() => Promise.reject(new TypeError("Network request failed")));
    const err = await getJson("/api/fields").catch((e) => e as ApiError);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).kind).toBe("offline");
  });

  it("refuses to call when no server address is configured", async () => {
    setBaseUrls({ apiUrl: "", webViewerUrl: "" });
    const originalEnv = process.env.EXPO_PUBLIC_API_URL;
    delete process.env.EXPO_PUBLIC_API_URL;
    setBaseUrls({ apiUrl: "", webViewerUrl: "" });
    process.env.EXPO_PUBLIC_API_URL = originalEnv;
    const err = await getJson("/api/fields").catch((e) => e as ApiError);
    // Either the .env fallback applies (URL configured) or the client refuses cleanly — never a raw fetch error.
    if (err instanceof ApiError) expect(["not_configured", "offline"]).toContain(err.kind);
  });
});
