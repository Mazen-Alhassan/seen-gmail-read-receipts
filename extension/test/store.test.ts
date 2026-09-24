import { describe, expect, it, vi } from "vitest";
import type { MessageSummary } from "../../shared/api";
import { StatusStore, type Lookup } from "../src/content/store";

function summary(token: string, over: Partial<MessageSummary> = {}): MessageSummary {
  return {
    token,
    sender: "me@example.com",
    subject: "Hi",
    recipients: [{ email: "a@example.com" }],
    sentAt: 1_000,
    threadId: null,
    messageId: null,
    status: "sent",
    opens: 0,
    firstOpenAt: null,
    lastOpenAt: null,
    lastClient: null,
    ...over,
  };
}

describe("StatusStore", () => {
  it("batches everything requested in the same moment into one lookup", async () => {
    vi.useFakeTimers();
    const lookup = vi.fn<Lookup>(async () => [summary("t1", { threadId: "th1" }), summary("t2", { threadId: "th1", sentAt: 2_000 })]);
    const store = new StatusStore(lookup);
    const seen: (string | undefined)[] = [];
    store.subscribe("th:th1", () => seen.push(store.latest("th:th1")?.token));
    store.subscribe("th:th2", () => undefined);
    store.subscribe("t:t9", () => undefined);
    await vi.advanceTimersByTimeAsync(200);

    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup.mock.calls[0]![0]).toEqual({ tokens: ["t9"], threadIds: ["th1", "th2"], messageIds: [] });
    expect(seen).toEqual(["t2"]); // newest message in the thread
    expect(store.get("th:th2")).toEqual([]);
    vi.useRealTimers();
  });

  it("caches answers, including 'not tracked', until refreshed", async () => {
    vi.useFakeTimers();
    let opened = false;
    const lookup = vi.fn<Lookup>(async () => [summary("t1", opened ? { status: "opened", opens: 1 } : {})]);
    const store = new StatusStore(lookup);
    store.subscribe("t:t1", () => undefined);
    await vi.advanceTimersByTimeAsync(200);
    store.subscribe("t:t1", () => undefined);
    store.ensure("t:t1");
    await vi.advanceTimersByTimeAsync(200);
    expect(lookup).toHaveBeenCalledTimes(1);

    opened = true;
    store.refreshWatched();
    await vi.advanceTimersByTimeAsync(200);
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(store.latest("t:t1")?.status).toBe("opened");
    vi.useRealTimers();
  });

  it("keeps working when the server is unreachable, and retries later", async () => {
    vi.useFakeTimers();
    let fail = true;
    const lookup = vi.fn<Lookup>(async () => {
      if (fail) throw new Error("offline");
      return [summary("t1")];
    });
    const store = new StatusStore(lookup);
    store.subscribe("t:t1", () => undefined);
    await vi.advanceTimersByTimeAsync(200);
    expect(store.latest("t:t1")).toBeNull();
    fail = false;
    store.ensure("t:t1"); // not cached after a failure
    await vi.advanceTimersByTimeAsync(200);
    expect(store.latest("t:t1")?.token).toBe("t1");
    vi.useRealTimers();
  });

  it("shows a just-sent email immediately and drops it when untracked", () => {
    const store = new StatusStore(async () => []);
    const calls: number[] = [];
    store.subscribe("th:x", () => calls.push(store.get("th:x").length));
    store.put(summary("t5", { threadId: "x" }));
    store.forget("t5");
    expect(calls).toEqual([1, 0]);
  });
});
