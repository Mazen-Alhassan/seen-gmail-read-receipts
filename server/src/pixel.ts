// A 1×1 fully transparent GIF (42 bytes).
const GIF = Uint8Array.from(
  atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"),
  (c) => c.charCodeAt(0),
);

// Ask every cache along the way (Google's image proxy included) not to keep a copy, so that
// later opens reach us too. Proxies may still cache, which is why repeat-open counts are a floor.
const HEADERS: Record<string, string> = {
  "Content-Type": "image/gif",
  "Content-Length": String(GIF.byteLength),
  "Cache-Control": "no-store, no-cache, must-revalidate, private, max-age=0",
  Pragma: "no-cache",
  Expires: "Thu, 01 Jan 1970 00:00:00 GMT",
  "X-Robots-Tag": "noindex, nofollow",
  "Access-Control-Allow-Origin": "*",
};

export function pixelResponse(head = false): Response {
  return new Response(head ? null : GIF, { status: 200, headers: HEADERS });
}
