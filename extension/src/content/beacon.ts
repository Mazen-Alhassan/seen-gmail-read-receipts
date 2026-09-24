/**
 * Self-view detection — the backup layer.
 *
 * Normally the extension's blocking rule stops your own Gmail from loading your own pixels at all,
 * so there's nothing to report. If one does load anyway (e.g. Gmail changed how it proxies
 * images), the fetch would look exactly like the recipient opening it. So when one of your pixels
 * actually *loads* on this page, we tell the server "that was me", and it discounts the Gmail-proxy
 * hit that arrived at that moment.
 *
 * Only real loads are reported: reporting pixels that were blocked would needlessly discount a
 * genuine open that happened to land while you were looking at the thread.
 */

import { extractToken, tokenUserId } from "../../../shared/token";

const DEDUPE_MS = 15_000;
const FLUSH_DELAY_MS = 150;

export function startSelfViewBeacon(
  host: string,
  userId: string,
  report: (tokens: string[]) => void,
  root: Node = document.documentElement,
): () => void {
  const selector = `img[src*="//${host}/i/"]`;
  const lastSent = new Map<string, number>();
  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    timer = null;
    if (pending.size === 0) return;
    const tokens = [...pending];
    pending.clear();
    report(tokens);
  };

  const queue = (token: string) => {
    const now = Date.now();
    const last = lastSent.get(token);
    if (last !== undefined && now - last < DEDUPE_MS) return;
    lastSent.set(token, now);
    pending.add(token);
    timer ??= setTimeout(flush, FLUSH_DELAY_MS);
  };

  const watched = new WeakSet<Element>();
  const consider = (img: Element) => {
    const token = extractToken(img.getAttribute("src") ?? "", host);
    // Only our own pixels: someone else's pixel in an email we received is a genuine open for them.
    if (!token || tokenUserId(token) !== userId) return;
    const el = img as HTMLImageElement;
    if (el.complete && el.naturalWidth > 0) queue(token); // already loaded
    if (!watched.has(el)) {
      watched.add(el);
      el.addEventListener("load", () => {
        const current = extractToken(el.getAttribute("src") ?? "", host);
        if (current && tokenUserId(current) === userId) queue(current);
      });
    }
  };

  const scan = (node: Node) => {
    if (!(node instanceof Element)) return;
    if (node.matches(selector)) consider(node);
    node.querySelectorAll(selector).forEach(consider);
  };

  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === "attributes") scan(m.target);
      else m.addedNodes.forEach(scan);
    }
  });
  observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["src"] });
  scan(root instanceof Document ? root.documentElement : root);

  return () => {
    observer.disconnect();
    if (timer) clearTimeout(timer);
  };
}
