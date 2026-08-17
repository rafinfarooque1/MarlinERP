/**
 * Letterhead logo validation — shared by the company profile and the
 * per-warehouse billing profile, so a logo obeys the same rules wherever it is
 * uploaded: only an inline PNG/JPEG data URI is stored (the PDF renderers embed
 * the bytes directly; jsPDF cannot fetch a URL or draw an SVG), empty clears it,
 * and the declared pixel size is checked from the format headers alone so a
 * tiny "image bomb" is rejected at upload time rather than decoded on every
 * document render.
 */

/**
 * Read the pixel dimensions from a PNG or JPEG buffer without decoding it.
 * Returns null when the header cannot be read (which callers should reject).
 */
export function imagePixelDimensions(buf: Buffer): { width: number; height: number } | null {
  // PNG: 8-byte signature, then the IHDR chunk with width/height at 16/20.
  if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // JPEG: walk the marker segments to the first SOF frame header.
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let o = 2;
    while (o + 9 < buf.length) {
      if (buf[o] !== 0xff) { o++; continue; }
      const marker = buf[o + 1];
      if (marker === 0xff) { o++; continue; }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.readUInt16BE(o + 5), width: buf.readUInt16BE(o + 7) };
      }
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) { o += 2; continue; }
      o += 2 + buf.readUInt16BE(o + 2);
    }
  }
  return null;
}

/**
 * Validate a submitted logo value. `null`/`''` clear the logo (value: null);
 * anything else must be a well-formed, size-bounded PNG/JPEG data URI.
 */
export function validateLogoDataUrl(v: unknown):
  | { ok: true; value: string | null }
  | { ok: false; error: string } {
  if (v === null || v === "") return { ok: true, value: null };
  if (typeof v !== "string" || !/^data:image\/(png|jpe?g);base64,[A-Za-z0-9+/=]+$/.test(v)) {
    return { ok: false, error: "Logo must be a PNG or JPEG data URI, or empty to remove the logo" };
  }
  if (v.length > 700_000) {
    return { ok: false, error: "Logo image is too large — please upload a smaller image" };
  }
  const dims = imagePixelDimensions(Buffer.from(v.slice(v.indexOf(",") + 1), "base64"));
  if (!dims || dims.width < 1 || dims.height < 1) {
    return { ok: false, error: "Logo image could not be read — please upload a valid PNG or JPEG" };
  }
  if (dims.width > 4096 || dims.height > 4096) {
    return { ok: false, error: "Logo image dimensions are too large — maximum 4096×4096 pixels" };
  }
  return { ok: true, value: v };
}
