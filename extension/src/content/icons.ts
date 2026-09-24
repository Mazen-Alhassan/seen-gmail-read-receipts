/** Small inline SVG icons, drawn to sit comfortably next to Gmail's own 16–20px glyphs. */

import type { MessageStatus } from "../../../shared/api";

export const COLORS = {
  sent: "#80868b",
  opened: "#188038",
  unconfirmed: "#b06000",
  on: "#1a73e8",
  off: "#80868b",
};

const tick = (x: number) => `M${1.5 + x} 8.6l2.9 2.9 6.2-6.7`;

function checks(status: MessageStatus): string {
  const color = COLORS[status];
  const common = `fill="none" stroke="${color}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"`;
  if (status === "sent") return `<path d="${tick(1.8)}" ${common}/>`;
  const dash = status === "unconfirmed" ? ` stroke-dasharray="2.2 1.8"` : "";
  return `<path d="${tick(-0.3)}" ${common}${dash}/><path d="${tick(3.7)}" ${common}${dash}/>`;
}

export function statusSvg(status: MessageStatus, size = 16): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="${size}" height="${size}" ` +
    `aria-hidden="true" focusable="false">${checks(status)}</svg>`
  );
}

export function eyeSvg(on: boolean): string {
  const c = on ? COLORS.on : COLORS.off;
  const eye =
    `<path d="M1.6 10s3-5.4 8.4-5.4S18.4 10 18.4 10s-3 5.4-8.4 5.4S1.6 10 1.6 10z" fill="none" ` +
    `stroke="${c}" stroke-width="1.6" stroke-linejoin="round"/>` +
    `<circle cx="10" cy="10" r="2.6" fill="${on ? c : "none"}" stroke="${c}" stroke-width="1.6"/>`;
  const slash = on ? "" : `<path d="M3.5 3.5l13 13" stroke="${c}" stroke-width="1.6" stroke-linecap="round"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" width="20" height="20">${eye}${slash}</svg>`;
}

export function dataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
