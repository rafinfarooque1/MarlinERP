/**
 * Normalise any uploaded image to a small PNG data URI (≤512px on the long
 * edge). Letterhead PDFs are rendered on the server and embed these bytes
 * directly — jsPDF cannot fetch a URL or draw an SVG — so everything is
 * converted to a format it can draw, at a size the API accepts.
 *
 * Shared by the company profile and the per-warehouse billing profile so both
 * uploads produce identical, embeddable values.
 */
export async function normaliseLogo(dataUrl: string): Promise<string> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error('Not a readable image'));
    i.src = dataUrl;
  });
  const iw = img.naturalWidth || 512;
  const ih = img.naturalHeight || 512;
  const scale = Math.min(1, 512 / Math.max(iw, ih));
  const w = Math.max(1, Math.round(iw * scale));
  const h = Math.max(1, Math.round(ih * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas unavailable');
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL('image/png');
}

/** Read a picked file as a data URL, or reject when unreadable. */
export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Could not read the file'));
    reader.readAsDataURL(file);
  });
}
