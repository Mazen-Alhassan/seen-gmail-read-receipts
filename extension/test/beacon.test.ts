import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startSelfViewBeacon } from "../src/content/beacon";
import { b64urlEncode, importMintKey, mintToken, newUserId, randomBytes } from "../../shared/token";

const HOST = "seen.example.com";

async function tokenFor(userId: string) {
  return mintToken(userId, await importMintKey(b64urlEncode(randomBytes(32))));
}

const flush = () => vi.advanceTimersByTimeAsync(200);
/** Simulate the browser finishing loading each new image on the page (i.e. nothing was blocked). */
let loaded = new WeakSet<Element>();
const loadAll = () =>
  document.querySelectorAll("img").forEach((img) => {
    if (loaded.has(img)) return;
    loaded.add(img);
    img.dispatchEvent(new Event("load"));
  });

describe("self-view beacon", () => {
  let reports: string[][];
  let stop: () => void;
  const me = newUserId();

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = "";
    loaded = new WeakSet();
    reports = [];
    stop = startSelfViewBeacon(HOST, me, (t) => reports.push(t));
  });
  afterEach(() => {
    stop();
    vi.useRealTimers();
  });

  it("reports my pixels that actually load through Gmail's image proxy", async () => {
    const token = await tokenFor(me);
    document.body.innerHTML = `<div class="a3s"><img src="https://ci5.googleusercontent.com/meips/X=s0-d-e1-ft#https://${HOST}/i/${token}.gif"></div>`;
    await flush();
    expect(reports).toEqual([]); // blocked (or not loaded yet): nothing happened on the server
    loadAll();
    await flush();
    expect(reports).toEqual([[token]]);
  });

  it("ignores other people's pixels from the same server — those are real opens for them", async () => {
    const theirs = await tokenFor(newUserId());
    document.body.innerHTML = `<img src="https://${HOST}/i/${theirs}.gif">`;
    loadAll();
    await flush();
    expect(reports).toEqual([]);
  });

  it("catches src changes, batches, and de-duplicates", async () => {
    const [a, b] = [await tokenFor(me), await tokenFor(me)];
    const img = document.createElement("img");
    document.body.append(img);
    await flush();
    img.setAttribute("src", `https://${HOST}/i/${a}.gif`);
    document.body.insertAdjacentHTML("beforeend", `<img src="https://${HOST}/i/${b}.gif"><img src="https://${HOST}/i/${a}.gif">`);
    await flush();
    loadAll();
    await flush();
    expect(reports).toEqual([[a, b]]);

    // Same message re-rendered moments later: not reported again…
    document.body.insertAdjacentHTML("beforeend", `<img src="https://${HOST}/i/${a}.gif">`);
    await flush();
    loadAll();
    await flush();
    expect(reports).toHaveLength(1);
    // …but it is once the de-dupe window has passed.
    await vi.advanceTimersByTimeAsync(16_000);
    document.body.insertAdjacentHTML("beforeend", `<img src="https://${HOST}/i/${a}.gif">`);
    await flush();
    loadAll();
    await flush();
    expect(reports).toEqual([[a, b], [a]]);
  });

  it("finds pixels already on the page when it starts", async () => {
    stop();
    const token = await tokenFor(me);
    document.body.innerHTML = `<img src="https://${HOST}/i/${token}.gif">`;
    stop = startSelfViewBeacon(HOST, me, (t) => reports.push(t));
    loadAll();
    await flush();
    expect(reports).toEqual([[token]]);
  });
});
