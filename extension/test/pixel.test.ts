import { describe, expect, it } from "vitest";
import { insertPixel, isPlainTextBody, pixelTag, pixelUrl, stripPixels } from "../src/content/pixel";

const HOST = "seen.example.com";
const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";
const url = pixelUrl(`https://${HOST}`, TOKEN);
const tag = pixelTag(url);
const blockTag = pixelTag(url, true);

describe("pixel markup", () => {
  it("builds an invisible 1×1 image with no alt text", () => {
    expect(tag).toContain(`src="https://${HOST}/i/${TOKEN}.gif"`);
    expect(tag).toContain('width="1" height="1"');
    expect(tag).toContain('alt=""');
    expect(tag).not.toMatch(/display:\s*none/);
  });

  it("goes inside the first block, so it shares the first line instead of adding one", () => {
    expect(insertPixel('<div dir="ltr">Hi Bob,<br>…</div>', url)).toBe(`<div dir="ltr">${tag}Hi Bob,<br>…</div>`);
    expect(insertPixel("<p class=x>Hello</p>", url)).toBe(`<p class=x>${tag}Hello</p>`);
  });

  it("goes at the very top otherwise, on its own 1px line (never at the bottom, where Gmail may clip it)", () => {
    expect(insertPixel("<table><tr><td>x</td></tr></table>", url)).toBe(`${blockTag}<table><tr><td>x</td></tr></table>`);
    const long = `<div dir="ltr">Hi</div>${"<p>quoted</p>".repeat(20_000)}`;
    expect(insertPixel(long, url).indexOf(tag)).toBeLessThan(100);
  });

  it("never goes inside a quote or signature (Gmail collapses those)", () => {
    const quoted = '<div class="gmail_quote"><div dir="ltr">On Mon, Bob wrote:</div></div>';
    expect(insertPixel(quoted, url)).toBe(blockTag + quoted);
  });

  it("isn't fooled by a > inside an attribute value", () => {
    const body = '<div dir="ltr" data-x="a>b">Hi</div>';
    expect(insertPixel(body, url)).toBe(`<div dir="ltr" data-x="a>b">${tag}Hi</div>`);
    const withPixel = `<div>${`<img alt="x>y" src="https://${HOST}/i/${TOKEN}.gif">`}Hi</div>`;
    expect(stripPixels(withPixel, HOST)).toBe("<div>Hi</div>");
  });

  it("recognises plain-text bodies (an <img> there would show up as text)", () => {
    expect(isPlainTextBody("Hi Femi,\n\nThanks for your time.\n\nMazen")).toBe(true);
    expect(isPlainTextBody("Is 3 < 4? Yes > 2.")).toBe(true);
    expect(isPlainTextBody('<div dir="ltr">Hi</div>')).toBe(false);
    expect(isPlainTextBody("Hi<br>there")).toBe(false);
  });

  it("strips earlier pixels, including Gmail-proxied copies in quoted replies", () => {
    const old = `<img src="https://${HOST}/i/${"z".repeat(32)}.gif" width="1" height="1">`;
    const proxied = `<img src="https://ci3.googleusercontent.com/meips/ADKq=s0-d-e1-ft#https://${HOST}/i/${"y".repeat(32)}.gif">`;
    const other = `<img src="https://cdn.example.org/logo.png" alt="Logo">`;
    const body = `<div dir="ltr">Thanks!</div><div class="gmail_quote">${old}Earlier${proxied}${other}</div>`;
    const cleaned = stripPixels(body, HOST);
    expect(cleaned).toBe(`<div dir="ltr">Thanks!</div><div class="gmail_quote">Earlier${other}</div>`);
  });

  it("is idempotent across repeated invocations of the send hook", () => {
    const body = '<div dir="ltr">Hello</div>';
    const once = insertPixel(stripPixels(body, HOST), url);
    const twice = insertPixel(stripPixels(once, HOST), url);
    expect(twice).toBe(once);
    expect(twice.split("<img").length - 1).toBe(1);
  });

  it("handles entity-encoded slashes and mixed-case hosts", () => {
    const sneaky = `<img src="https:&#x2f;&#x2f;SEEN.example.com&#x2f;i&#x2f;${TOKEN}.gif">`;
    expect(stripPixels(`a${sneaky}b`, HOST)).toBe("ab");
  });
});
