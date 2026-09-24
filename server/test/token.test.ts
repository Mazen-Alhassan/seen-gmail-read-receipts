import { describe, expect, it } from "vitest";
import {
  TOKEN_RE,
  b64urlDecode,
  b64urlEncode,
  extractToken,
  importMintKey,
  mintToken,
  newUserId,
  pixelPath,
  randomBytes,
  tokenPrefix,
  tokenUserId,
  verifyToken,
} from "../../shared/token";

const mintKey = () => b64urlEncode(randomBytes(32));

describe("tokens", () => {
  it("round-trips base64url", () => {
    for (let n = 0; n < 40; n++) {
      const bytes = randomBytes(n);
      expect(b64urlDecode(b64urlEncode(bytes))).toEqual(bytes);
    }
    expect(b64urlDecode("not base64!")).toBeNull();
  });

  it("mints 32-char tokens that carry the user id and verify with the right key", async () => {
    const uid = newUserId();
    const key = await importMintKey(mintKey());
    const token = await mintToken(uid, key);
    expect(token).toMatch(TOKEN_RE);
    expect(tokenUserId(token)).toBe(uid);
    expect(await verifyToken(token, key)).toBe(true);
  });

  it("rejects tokens signed with another key or tampered with", async () => {
    const uid = newUserId();
    const key = await importMintKey(mintKey());
    const other = await importMintKey(mintKey());
    const token = await mintToken(uid, key);
    expect(await verifyToken(token, other)).toBe(false);

    const flipped = token.slice(0, 15) + (token[15] === "A" ? "B" : "A") + token.slice(16);
    expect(await verifyToken(flipped, key)).toBe(false);
    expect(await verifyToken("x".repeat(32), key)).toBe(false);
    expect(await verifyToken(token.slice(1), key)).toBe(false);
  });

  it("starts every token of a user with the same prefix, and only theirs", async () => {
    const a = newUserId();
    const b = newUserId();
    const key = await importMintKey(mintKey());
    for (let i = 0; i < 50; i++) {
      expect((await mintToken(a, key)).startsWith(tokenPrefix(a))).toBe(true);
      expect((await mintToken(b, key)).startsWith(tokenPrefix(a))).toBe(tokenPrefix(a) === tokenPrefix(b));
    }
  });

  it("mints unique tokens", async () => {
    const uid = newUserId();
    const key = await importMintKey(mintKey());
    const tokens = await Promise.all(Array.from({ length: 200 }, () => mintToken(uid, key)));
    expect(new Set(tokens).size).toBe(200);
  });

  it("extracts tokens from direct and Gmail-proxied image URLs", async () => {
    const token = await mintToken(newUserId(), await importMintKey(mintKey()));
    const host = "seen.example.com";
    const direct = `https://${host}${pixelPath(token)}`;
    const proxied = `https://ci3.googleusercontent.com/meips/ADKq_NbXyz=s0-d-e1-ft#${direct}`;
    expect(extractToken(direct, host)).toBe(token);
    expect(extractToken(proxied, host)).toBe(token);
    expect(extractToken(proxied, "other.example.com")).toBeNull();
    expect(extractToken(`https://${host}/i/short.gif`, host)).toBeNull();
  });
});
