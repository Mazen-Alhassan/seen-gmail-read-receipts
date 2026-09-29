import { describe, expect, it } from "vitest";
import { decodeConnectionCode, encodeConnectionCode, normaliseServerUrl } from "../src/lib/config";
import { gmailThreadUrl, notificationTitle, recipientsLabel, relativeTime, statusLine } from "../src/lib/format";
import { ownToken, undoneToken } from "../src/content/gmail";
import { FOLLOW_UPS, greeting } from "../src/lib/followups";
import { TokenPool } from "../src/content/tokens";
import { b64urlEncode, importMintKey, mintToken, newUserId, randomBytes } from "../../shared/token";

describe("normaliseServerUrl", () => {
  it("accepts bare hosts and strips paths", () => {
    expect(normaliseServerUrl("seen.example.com/")).toBe("https://seen.example.com");
    expect(normaliseServerUrl(" https://seen.example.com/api ")).toBe("https://seen.example.com");
    expect(normaliseServerUrl("http://localhost:8787")).toBe("http://localhost:8787");
  });
  it("refuses plain http for real hosts", () => {
    expect(normaliseServerUrl("http://seen.example.com")).toBeNull();
    expect(normaliseServerUrl("")).toBeNull();
  });
});

describe("format", () => {
  const now = Date.UTC(2026, 8, 21, 12);
  it("describes time and people briefly", () => {
    expect(relativeTime(now - 10_000, now)).toBe("just now");
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5m ago");
    expect(relativeTime(now - 3 * 3600_000, now)).toBe("3h ago");
    expect(recipientsLabel([{ name: "Alice Smith", email: "a@x.com" }])).toBe("Alice");
    expect(recipientsLabel([{ email: "bob@x.com" }, { email: "c@x.com" }])).toBe("bob and c");
    expect(recipientsLabel([{ email: "a@x" }, { email: "b@x" }, { email: "c@x" }])).toBe("a +2");
  });
  it("summarises status in one line", () => {
    const base = { token: "t", sender: "", subject: "", recipients: [], threadId: null, messageId: null, lastClient: null };
    expect(statusLine({ ...base, sentAt: now - 60_000, status: "sent", opens: 0, firstOpenAt: null, lastOpenAt: null }, now)).toBe(
      "Not opened yet · sent 1m ago",
    );
    expect(
      statusLine({ ...base, sentAt: 0, status: "opened", opens: 3, firstOpenAt: 1, lastOpenAt: now - 7200_000 }, now),
    ).toBe("Opened 3× · last 2h ago");
  });
  it("writes notification titles and Gmail links", () => {
    const e = { token: "t", sender: "me@x.com", subject: "S", threadId: "18f", at: 0, client: "gmail" as const, detail: "Gmail" };
    expect(notificationTitle({ ...e, recipients: [{ name: "Alice", email: "a@x" }], first: true })).toBe("Alice opened your email");
    expect(notificationTitle({ ...e, recipients: [{ email: "a@x" }, { email: "b@x" }, { email: "c@x" }], first: false })).toBe(
      "Your email to a +2 was opened again",
    );
    expect(gmailThreadUrl("me@x.com", "18f")).toBe("https://mail.google.com/mail/?authuser=me%40x.com#all/18f");
  });
});

describe("ownToken", () => {
  it("finds this message's own pixel, not a quoted one from an earlier email", async () => {
    const me = newUserId();
    const key = await importMintKey(b64urlEncode(randomBytes(32)));
    const [mine, quoted] = [await mintToken(me, key), await mintToken(me, key)];
    const host = "seen.example.com";
    const body = document.createElement("div");
    body.innerHTML =
      `<div class="gmail_quote"><img src="https://ci3.googleusercontent.com/meips/Q#https://${host}/i/${quoted}.gif"></div>` +
      `<div dir="ltr"><img src="https://ci3.googleusercontent.com/meips/P#https://${host}/i/${mine}.gif">Hi</div>`;
    expect(ownToken(body, host, me)).toBe(mine);
    expect(ownToken(body, host, newUserId())).toBeNull();
  });
});

describe("TokenPool", () => {
  it("keeps tokens ready and refills in the background", async () => {
    let n = 0;
    const pool = new TokenPool(async (count) => Array.from({ length: count }, () => `tok${n++}`), 2);
    await pool.fill();
    expect(await pool.take(10)).toBe("tok0");
    expect(await pool.take(10)).toBe("tok1");
    expect(await pool.take(10)).toBe("tok2");
  });

  it("gives up quickly rather than holding up a send", async () => {
    const pool = new TokenPool(() => new Promise(() => undefined));
    const started = Date.now();
    expect(await pool.take(50)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("discards tokens after reconnecting as a different user", async () => {
    let user = "A";
    const pool = new TokenPool(async (count) => Array.from({ length: count }, () => user), 2);
    await pool.fill();
    pool.reset();
    user = "B";
    expect(await pool.take(100)).toBe("B");
  });
});

describe("connection codes", () => {
  it("round-trip a connection so another browser can join the same account", () => {
    const conn = { serverUrl: "https://seen.example.workers.dev", userId: "xS7O6wM4WIc", apiKey: "k".repeat(43), mintKey: "m".repeat(43) };
    const code = encodeConnectionCode(conn);
    expect(code.startsWith("seen1_")).toBe(true);
    expect(decodeConnectionCode(`  ${code}\n`)).toEqual(conn);
  });
  it("rejects anything else", () => {
    expect(decodeConnectionCode("seen-abcd-1234-wxyz")).toBeNull(); // an invite code, not a connection code
    expect(decodeConnectionCode("seen1_!!!")).toBeNull();
    expect(decodeConnectionCode("seen1_" + btoa("{}"))).toBeNull();
  });
});

import { countLabel, pillGeometry } from "../src/background/badge";

describe("icon count", () => {
  it("stays small: a digit, or 9+", () => {
    expect([1, 9, 10, 250].map(countLabel)).toEqual(["1", "9", "9+", "9+"]);
  });
  it("sits in the bottom-left corner, about half the icon's height", () => {
    expect(pillGeometry(16, "3")).toEqual({ x: 0, y: 7, w: 9, h: 9, ring: 1 });
    expect(pillGeometry(32, "9+")).toMatchObject({ x: 0, y: 14, h: 18, w: 27 });
  });
});

describe("undo send", () => {
  it("recognises an email reopened by Undo (our fresh pixel at the top, not quoted)", async () => {
    const me = newUserId();
    const key = await importMintKey(b64urlEncode(randomBytes(32)));
    const [justSent, older] = [await mintToken(me, key), await mintToken(me, key)];
    const host = "seen.example.com";
    const body = document.createElement("div");
    body.innerHTML = `<div dir="ltr"><img src="https://${host}/i/${justSent}.gif">Hey Femi!</div>`;
    const now = 1_000_000;
    expect(undoneToken(body, host, me, new Map([[justSent, now - 5_000]]), now)).toBe(justSent);
    // Not something this tab just sent (e.g. an old email pasted in) → leave it alone.
    expect(undoneToken(body, host, me, new Map(), now)).toBeNull();
    expect(undoneToken(body, host, me, new Map([[justSent, now - 10 * 60_000]]), now)).toBeNull();
    // A reply quoting an earlier email isn't an undo.
    body.innerHTML = `<div dir="ltr">Following up</div><div class="gmail_quote"><img src="https://${host}/i/${older}.gif"></div>`;
    expect(undoneToken(body, host, me, new Map([[older, now - 5_000]]), now)).toBeNull();
  });
});

describe("follow-up greetings", () => {
  const hi = (name: string | undefined, email: string) => greeting([{ name, email } as never]);

  it("finds a first name in the shapes Gmail hands us", () => {
    expect(hi("Nadav Cohen", "nadav@eve.security")).toBe("Hey Nadav");
    expect(hi(undefined, "brandon@mindfort.ai")).toBe("Hey Brandon");
    expect(hi(undefined, "scott.ponte@robinhood.com")).toBe("Hey Scott");
    expect(hi(undefined, "ada_lovelace@example.com")).toBe("Hey Ada");
    // The directory form some companies use, trailing disambiguator and all.
    expect(hi("Nugent, Catherine 1", "catherine.1.nugent@global.lmco.com")).toBe("Hey Catherine");
    expect(hi("NEAL", "neal@manifold.security")).toBe("Hey Neal");
  });

  it("would rather greet nobody than greet the wrong name", () => {
    // Guessing a name from a role address means opening a cold email with "Hey Careers".
    expect(hi(undefined, "careers@example.com")).toBe("Hey");
    expect(hi(undefined, "hr@example.com")).toBe("Hey");
    expect(hi(undefined, "cy@aegisai.ai")).toBe("Hey"); // initials are a coin flip
    expect(greeting([])).toBe("Hey");
    expect(hi("support@example.com", "support@example.com")).toBe("Hey");
  });

  it("writes short, sendable follow-ups", () => {
    expect(FOLLOW_UPS).toHaveLength(4);
    expect(new Set(FOLLOW_UPS.map((f) => f.id)).size).toBe(4);
    for (const f of FOLLOW_UPS) {
      const body = f.body("Hey Nadav");
      expect(body.startsWith("Hey Nadav,")).toBe(true);
      expect(body.trim().split(/\n\s*\n/).length).toBeLessThanOrEqual(4);
      expect(body.length).toBeLessThan(320);
      // A follow-up that mentions tracking gives the game away.
      expect(body.toLowerCase()).not.toMatch(/opened|seen it|tracking/);
    }
  });
});
