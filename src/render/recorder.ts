/** Canvas capture: PNG screenshots, and the browser download flow every export saves through.
 * (Video comes from takes: record → timeline → Export video, see src/record/.) */

/** Local date-time for file names, e.g. 2026-10-16_14-03-59. */
export function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_` +
         `${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

export function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);   // detached-anchor clicks can silently no-op
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function screenshot(canvas: HTMLCanvasElement, prefix = "r1-sim") {
  canvas.toBlob((b) => { if (b) download(b, `${prefix}_${stamp()}.png`); }, "image/png");
}
