import { getJson } from "@/services/apiClient";
import { signedViewerUrl } from "@/services/auth";
import { setAuthTokenGetter, setBaseUrls, setUnauthorizedHandler } from "@/services/runtimeConfig";

const okJson = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));

describe("sign-in", () => {
  const fetchMock = jest.fn();
  let token: string | null = "tok-123";
  const onUnauthorized = jest.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    onUnauthorized.mockReset();
    token = "tok-123";
    global.fetch = fetchMock as unknown as typeof fetch;
    setBaseUrls({ apiUrl: "https://agrotwin.example.edu", webViewerUrl: "https://agrotwin.example.edu/" });
    setAuthTokenGetter(() => token);
    setUnauthorizedHandler(onUnauthorized);
  });

  it("sends the session token as a Bearer header", async () => {
    fetchMock.mockImplementation(() => okJson([]));
    await getJson("/api/fields");
    expect((fetchMock.mock.calls[0]![1] as RequestInit).headers).toMatchObject({ Authorization: "Bearer tok-123" });
  });

  it("ends the session when the server answers 401 to a signed-in request", async () => {
    fetchMock.mockImplementation(() => okJson({ detail: "Please sign in" }, 401));
    await expect(getJson("/api/fields")).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("does not sign out on a 401 without a session (e.g. a wrong password)", async () => {
    token = null;
    fetchMock.mockImplementation(() => okJson({ detail: "Wrong email or password" }, 401));
    await expect(getJson("/api/auth/me")).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("opens the embedded viewer through a one-time hand-off code", async () => {
    fetchMock.mockImplementation(() => okJson({ code: "abc-123", expires_in: 60 }));
    const viewer = "https://agrotwin.example.edu/fields/f1/digital-twin?survey=s1&embed=1";
    const url = await signedViewerUrl(viewer, true);
    expect(fetchMock.mock.calls[0]![0]).toBe("https://agrotwin.example.edu/api/auth/handoff");
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/auth/handoff");
    expect(parsed.searchParams.get("code")).toBe("abc-123");
    expect(parsed.searchParams.get("next")).toBe("/fields/f1/digital-twin?survey=s1&embed=1");
    expect(await signedViewerUrl(viewer, false)).toBe(viewer); // signed out: no hand-off
  });
});
