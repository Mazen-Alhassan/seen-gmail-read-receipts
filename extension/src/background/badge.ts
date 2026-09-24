/**
 * The toolbar icon with a small red count in its bottom-left corner. Chrome's own badge is always
 * large and bottom-right, so the count is drawn into the icon image instead.
 */

const SIZES = [16, 32] as const;
const RED = "#d93025";

let baseIcons: Map<number, ImageBitmap> | null = null;

async function loadBaseIcons(): Promise<Map<number, ImageBitmap>> {
  if (baseIcons) return baseIcons;
  const entries = await Promise.all(
    SIZES.map(async (size) => {
      const blob = await (await fetch(chrome.runtime.getURL(`icons/icon${size}.png`))).blob();
      return [size, await createImageBitmap(blob)] as const;
    }),
  );
  baseIcons = new Map(entries);
  return baseIcons;
}

export function countLabel(count: number): string {
  return count > 9 ? "9+" : String(count);
}

/** Geometry of the red pill for an icon of `size` px (exported for tests/previews). */
export function pillGeometry(size: number, label: string) {
  const h = Math.round(size * 0.56); // 9px on a 16px icon
  const w = label.length > 1 ? Math.round(h * 1.5) : h;
  const ring = size >= 32 ? 2 : 1; // thin white outline so it reads against the blue icon
  return { x: 0, y: size - h, w, h, ring };
}

export function drawCountIcon(
  ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
  size: number,
  icon: CanvasImageSource,
  count: number,
): void {
  const label = countLabel(count);
  const { x, y, w, h, ring } = pillGeometry(size, label);
  ctx.clearRect(0, 0, size, size);
  ctx.drawImage(icon, 0, 0, size, size);

  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, h / 2);
  ctx.fill();

  ctx.fillStyle = RED;
  ctx.beginPath();
  ctx.roundRect(x + ring, y + ring, w - 2 * ring, h - 2 * ring, (h - 2 * ring) / 2);
  ctx.fill();

  const inner = h - 2 * ring;
  ctx.fillStyle = "#ffffff";
  ctx.font = `700 ${Math.round(inner * (label.length > 1 ? 0.78 : 0.86))}px -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, x + w / 2, y + h / 2 + inner * 0.05);
}

/** Show `count` on the toolbar icon (0 restores the plain icon). */
export async function showCountOnIcon(count: number): Promise<void> {
  if (count <= 0) {
    await chrome.action.setIcon({ path: { 16: "icons/icon16.png", 32: "icons/icon32.png" } });
    return;
  }
  const icons = await loadBaseIcons();
  const imageData: Record<number, ImageData> = {};
  for (const size of SIZES) {
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    drawCountIcon(ctx, size, icons.get(size)!, count);
    imageData[size] = ctx.getImageData(0, 0, size, size);
  }
  await chrome.action.setIcon({ imageData });
}
