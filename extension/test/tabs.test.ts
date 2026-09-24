import { describe, expect, it, vi } from "vitest";
import { refreshIdleGmailTabs } from "../src/background/tabs";

function fakeChrome(
  tabs: { id?: number; discarded?: boolean; composing?: boolean; unscriptable?: boolean; active?: boolean; audible?: boolean }[],
) {
  const reload = vi.fn(async (_id: number) => undefined);
  (globalThis as unknown as { chrome: unknown }).chrome = {
    tabs: {
      query: async () => tabs.map(({ id, discarded, active, audible }) => ({ id, discarded: !!discarded, active: !!active, audible: !!audible })),
      reload,
    },
    scripting: {
      executeScript: async ({ target }: { target: { tabId: number } }) => {
        const t = tabs.find((x) => x.id === target.tabId)!;
        if (t.unscriptable) throw new Error("Cannot access contents of the page");
        return [{ result: !!t.composing }];
      },
    },
  };
  return reload;
}

describe("refreshIdleGmailTabs", () => {
  it("refreshes idle background Gmail tabs, never one you're using or writing in", async () => {
    const reload = fakeChrome([
      { id: 1 },
      { id: 2, composing: true },
      { id: 3, discarded: true },
      { id: 4, unscriptable: true },
      { id: 5, active: true }, // you're looking at it: it refreshes itself once you switch away
      { id: 6, audible: true }, // a call in Chat/Meet
      {},
    ]);
    expect(await refreshIdleGmailTabs()).toBe(1);
    expect(reload.mock.calls).toEqual([[1]]);
  });
});
