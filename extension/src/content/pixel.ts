/**
 * Pixel markup, applied to the HTML of Gmail's outgoing send request (never to the compose
 * window's DOM, so the sender's own browser never loads it).
 */

import { pixelPath } from "../../../shared/token";

export function pixelUrl(serverUrl: string, token: string): string {
  return `${serverUrl}${pixelPath(token)}`;
}

/**
 * 1×1, transparent, no alt text. Visible-size (not 0×0 or display:none), because some clients
 * skip fetching images they consider hidden. `block` for when it has to sit on its own line
 * (it then takes 1px of height instead of a line of text).
 */
export function pixelTag(url: string, block = false): string {
  return (
    `<img src="${url}" alt="" width="1" height="1" border="0" ` +
    `style="${block ? "display:block;" : ""}width:1px;height:1px;border:0;margin:0;padding:0">`
  );
}

// An HTML tag, reading quoted attribute values whole so a ">" inside one can't end the tag early.
const ATTRS = `(?:[^>"']|"[^"]*"|'[^']*')*`;
const IMG_TAG = new RegExp(`<img\\b${ATTRS}>`, "gi");

/**
 * Gmail's current send path doesn't tell us about plain-text mode, so recognise a plain-text body
 * ourselves: it has no HTML at all. Adding an <img> there would show up as literal text.
 */
export function isPlainTextBody(html: string): boolean {
  return !/<\/?[a-z][a-z0-9]*\b[^>]*>|<br\s*\/?>/i.test(html);
}

/**
 * Remove every pixel from `host`, including ones inside quoted replies. Otherwise, replying to a
 * thread would carry your earlier emails' pixels along and mark them opened again.
 */
export function stripPixels(html: string, host: string): string {
  const needle = `//${host.toLowerCase()}/i/`;
  return html.replace(IMG_TAG, (tag) => (decodeEntities(tag).toLowerCase().includes(needle) ? "" : tag));
}

// The leading block we put the pixel inside, so it shares the first line of text instead of adding
// an empty line above it. Never a quote: quoted text is collapsed by Gmail and may never render.
const LEADING_BLOCK = new RegExp(`^(\\s*)<(div|p|span)\\b(${ATTRS})>`, "i");

/**
 * Put the pixel at the very top of the message. Gmail clips messages over ~102KB and never loads
 * anything below the cut, so a pixel at the bottom of a long thread would silently never fire.
 */
export function insertPixel(html: string, url: string): string {
  const m = LEADING_BLOCK.exec(html);
  if (m && !/gmail_quote|gmail_attr|gmail_signature/i.test(m[3] ?? "")) {
    const at = m[0].length;
    return html.slice(0, at) + pixelTag(url) + html.slice(at);
  }
  return pixelTag(url, true) + html;
}

function decodeEntities(s: string): string {
  return s.replace(/&#x2f;|&#47;/gi, "/").replace(/&amp;/gi, "&");
}
