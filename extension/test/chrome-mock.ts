/** Just enough of chrome.storage.local for the modules under test. */
export function installChromeStorage(): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  const keys = (k: string | string[]) => (Array.isArray(k) ? k : [k]);
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: { id: "test-extension" },
    storage: {
      local: {
        get: async (k: string | string[]) =>
          Object.fromEntries(keys(k).filter((x) => x in data).map((x) => [x, structuredClone(data[x])])),
        set: async (items: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(items)) data[k] = structuredClone(v);
        },
        remove: async (k: string | string[]) => {
          for (const x of keys(k)) delete data[x];
        },
      },
    },
  };
  return data;
}
