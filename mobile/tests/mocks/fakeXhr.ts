/** The multipart fields as a plain object. The file part is only marked as
 * present: React Native sends {uri, name, type}, which Node's FormData (used
 * under jest) turns into a string. */
export function fields(body: FormData): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  body.forEach((v, k) => {
    out[k] = k === "file" ? "<file>" : v;
  });
  return out;
}

/** Picked files (GCP points, flight plans) go up with XMLHttpRequest, like the
 * photos: React Native's fetch fails on Android for a multipart body holding a
 * picked file. This records what was sent and answers with FakeXhr.reply. */
export class FakeXhr {
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
