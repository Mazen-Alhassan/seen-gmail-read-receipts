import { beforeEach, describe, expect, it, vi } from "vitest";
import { backoff, enqueue, flush, merge, pendingCount, type Op } from "../src/background/queue";
import { installChromeStorage } from "./chrome-mock";

const conn = { serverUrl: "https://seen.test", userId: "u", apiKey: "k", mintKey: "m" };
const msg = { sender: "me@x.com", subject: "S", recipients: [{ email: "a@x.com" }], sentAt: 1 };

function respond(...statuses: (number | "offline")[]) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  let i = 0;
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : undefined });
    const s = statuses[Math.min(i++, statuses.length - 1)]!;
    if (s === "offline") throw new TypeError("Failed to fetch");
    return new Response(s === 204 ? null : JSON.stringify({ error: "x" }), { status: s });
  });
  return calls;
}

describe("outbox", () => {
  beforeEach(() => {
    installChromeStorage();
    vi.unstubAllGlobals();
  });

  it("delivers queued registrations", async () => {
    const calls = respond(204);
    await enqueue({ kind: "put", token: "T1", message: msg });
    expect(await flush(conn)).toBe(0);
    expect(calls).toEqual([
      { url: "https://seen.test/api/messages/T1", method: "PUT", body: { ...msg, clientNow: expect.any(Number) } },
    ]);
  });

  it("keeps them through an outage and delivers once back online", async () => {
    respond("offline");
    await enqueue({ kind: "put", token: "T1", message: msg });
    await enqueue({ kind: "put", token: "T2", message: msg });
    expect(await flush(conn, 1_000)).toBe(2);

    // Not due yet: nothing is attempted.
    const early = respond(204);
    expect(await flush(conn, 1_000 + 1_000)).toBe(2);
    expect(early).toHaveLength(0);

    // After the backoff, both go through.
    const later = respond(204);
    expect(await flush(conn, 1_000 + backoff(1) + 1)).toBe(0);
    expect(later.map((c) => c.url)).toEqual(["https://seen.test/api/messages/T1", "https://seen.test/api/messages/T2"]);
  });

  it("retries server errors but drops permanent rejections", async () => {
    respond(503, 400);
    await enqueue({ kind: "put", token: "T1", message: msg });
    await enqueue({ kind: "put", token: "T2", message: msg });
    expect(await flush(conn)).toBe(1); // T1 kept for retry (503), T2 dropped (400)
  });

  it("merges updates to the same email, keeping ids learned earlier", async () => {
    respond("offline");
    await enqueue({ kind: "put", token: "T1", message: { ...msg, threadId: "th", messageId: "m1" } });
    await enqueue({ kind: "put", token: "T1", message: { ...msg, subject: "New" } });
    expect(await pendingCount()).toBe(1);
    const calls = respond(204);
    await flush(conn, Date.now() + 10 * 60_000);
    expect(calls[0]!.body).toEqual({ ...msg, subject: "New", threadId: "th", messageId: "m1", clientNow: expect.any(Number) });
  });

  it("lets a delete supersede a pending registration, and never the other way round", () => {
    const put: Op = { kind: "put", token: "T", message: msg, attempts: 3, nextAt: 9 };
    const del: Op = { kind: "delete", token: "T", attempts: 0, nextAt: 0 };
    expect(merge(put, del)).toBe(del);
    expect(merge(del, put)).toBe(del); // a late update after Undo can't bring it back
  });

  it("never re-registers an email once it has been untracked", async () => {
    respond(204);
    await enqueue({ kind: "delete", token: "T9" });
    await flush(conn);
    const calls = respond(204);
    await enqueue({ kind: "put", token: "T9", message: msg }); // e.g. Gmail's late "sent" update
    expect(await pendingCount()).toBe(0);
    await flush(conn);
    expect(calls).toHaveLength(0);
  });

  it("backs off exponentially, capped at 30 minutes", () => {
    expect([1, 2, 3, 4].map(backoff)).toEqual([15_000, 30_000, 60_000, 120_000]);
    expect(backoff(50)).toBe(30 * 60_000);
  });
});
