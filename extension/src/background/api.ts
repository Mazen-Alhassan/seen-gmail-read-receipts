import type { Connection } from "../lib/config";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }

  /** Worth retrying later (network trouble, server hiccup, rate limit) vs. permanently rejected. */
  get retryable(): boolean {
    return this.status === 0 || this.status === 408 || this.status === 429 || this.status >= 500;
  }
}

const TIMEOUT_MS = 15_000;

/** Server clock minus local clock, learned from response Date headers (second precision). */
let clockOffsetMs = 0;
export const serverNow = (): number => Date.now() + clockOffsetMs;

/** Called when the server rejects our API key (e.g. this account was deleted from another browser). */
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

export async function call<T>(
  conn: Pick<Connection, "serverUrl" | "apiKey"> | { serverUrl: string; apiKey?: undefined },
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = {};
  if (conn.apiKey) headers.Authorization = `Bearer ${conn.apiKey}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${conn.serverUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
      cache: "no-store",
    });
  } catch (err) {
    throw new ApiError(0, `Can't reach the Seen server (${err instanceof Error ? err.message : err})`);
  } finally {
    clearTimeout(timer);
  }

  const date = Date.parse(res.headers.get("Date") ?? "");
  if (Number.isFinite(date)) {
    const offset = date - Date.now();
    // Ignore sub-2s differences: the header only has second precision.
    clockOffsetMs = Math.abs(offset) > 2_000 ? offset : 0;
  }

  if (res.status === 401 && conn.apiKey) onUnauthorized?.();
  if (!res.ok) {
    let code = res.statusText;
    try {
      code = ((await res.json()) as { error?: string }).error ?? code;
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, code || `HTTP ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
