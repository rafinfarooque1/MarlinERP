/**
 * Object storage — presigned upload + object serving.
 *
 * Used for expense bills and receipts. The file never passes through this
 * server: the client asks for a presigned URL and PUTs the bytes straight to
 * GCS, and we only ever store the resulting object path on the expense row.
 *
 * Auth: this app authenticates with bearer tokens through the global
 * `requireAuth` guard mounted on /api, so there is no session and no
 * `req.isAuthenticated()`. Both routes below are already behind that guard —
 * `req.employee` is present on every request that reaches them, and its absence
 * would mean the guard was bypassed, so it is treated as unauthorised.
 */
import { Readable } from "stream";
import { Router, type IRouter, type Request, type Response } from "express";

import { pool } from "@workspace/db";

import { ObjectNotFoundError, ObjectStorageService } from "../lib/objectStorage";

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();

/** Bills and receipts only: a scan or a photo. Anything else has no business
 *  being attached to a voucher, and an unbounded size would let one upload
 *  exhaust the bucket. */
const ALLOWED_CONTENT_TYPES = new Set([
  "image/jpeg", "image/png", "image/webp", "image/heic", "image/heif",
  "application/pdf",
]);
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB

router.post("/storage/uploads/request-url", async (req: Request, res: Response) => {
  const employee = (req as any).employee;
  if (!employee) { res.status(401).json({ error: "Unauthorized" }); return; }

  const name = String((req.body as any)?.name ?? "").trim();
  const size = Number((req.body as any)?.size);
  const contentType = String((req.body as any)?.contentType ?? "").trim().toLowerCase();

  if (!name || name.length > 255) {
    res.status(400).json({ error: "A file name is required." }); return;
  }
  if (!Number.isFinite(size) || size <= 0) {
    res.status(400).json({ error: "The file appears to be empty." }); return;
  }
  if (size > MAX_UPLOAD_BYTES) {
    res.status(400).json({
      error: `That file is too large. Attachments must be under ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB.`,
    });
    return;
  }
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
    res.status(400).json({ error: "Only images (JPG, PNG, WEBP, HEIC) and PDF files can be attached." });
    return;
  }

  try {
    const uploadURL = await objectStorageService.getObjectEntityUploadURL(Number(employee.id));
    const objectPath = objectStorageService.normalizeObjectEntityPath(uploadURL);
    res.json({ uploadURL, objectPath, metadata: { name, size, contentType } });
  } catch (error) {
    req.log?.error({ err: error }, "Error generating upload URL");
    res.status(500).json({ error: "Failed to generate upload URL" });
  }
});

/**
 * May this caller read this object?
 *
 * A bill can carry a vendor's bank details, and this ERP scopes expenses by
 * location, so "signed in" is not a sufficient answer — a branch user must not
 * be able to pull another branch's bill by holding its URL. An object is
 * readable in exactly two cases:
 *
 *   1. The caller uploaded it and has not attached it to anything yet. Their id
 *      is in the path, so this needs no lookup.
 *   2. It is attached to an expense the caller is already allowed to see, which
 *      is the same location rule GET /expenses applies.
 *
 * Anything else is reported as missing rather than forbidden, so the response
 * does not confirm that some other branch's document exists.
 */
async function mayReadObject(employee: any, objectPath: string): Promise<boolean> {
  const own = objectPath.match(/^\/objects\/uploads\/(\d+)\//);
  if (own && Number(own[1]) === Number(employee.id)) return true;

  const { rows } = await pool.query(
    `SELECT location_type, location_id FROM expenses  WHERE attachment_url = $1
     UNION ALL
     SELECT location_type, location_id FROM payments  WHERE attachment_url = $1`,
    [objectPath],
  );
  if (rows.length === 0) return false;

  if (!employee.branchType || employee.branchType === 'headoffice') return true;
  return rows.some(
    (r: any) => r.location_type === employee.branchType && Number(r.location_id) === Number(employee.branchId),
  );
}

/**
 * GET /storage/objects/*
 *
 * Serves an uploaded bill, behind the global auth guard and the scope check
 * above.
 */
router.get("/storage/objects/*path", async (req: Request, res: Response) => {
  const employee = (req as any).employee;
  if (!employee) { res.status(401).json({ error: "Unauthorized" }); return; }

  try {
    const raw = (req.params as any).path;
    const wildcardPath = Array.isArray(raw) ? raw.join("/") : raw;
    const objectPath = `/objects/${wildcardPath}`;

    if (!(await mayReadObject(employee, objectPath))) {
      res.status(404).json({ error: "Attachment not found" });
      return;
    }

    const objectFile = await objectStorageService.getObjectEntityFile(objectPath);
    const response = await objectStorageService.downloadObject(objectFile);

    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));
    // The signed PUT cannot bind the declared content type, so what actually
    // landed in the bucket may not be what was vetted at request time. Serving
    // it inline would let a smuggled HTML file run as script on this origin, so
    // pin the type and hand it to the browser as a download.
    const served = String(response.headers.get("content-type") ?? "").toLowerCase().split(";")[0].trim();
    if (!ALLOWED_CONTENT_TYPES.has(served)) {
      res.setHeader("Content-Type", "application/octet-stream");
    }
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    res.setHeader("Content-Disposition", "attachment");
    if (response.body) {
      Readable.fromWeb(response.body as any).pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    if (error instanceof ObjectNotFoundError) {
      res.status(404).json({ error: "Attachment not found" });
      return;
    }
    req.log?.error({ err: error }, "Error serving object");
    res.status(500).json({ error: "Failed to serve attachment" });
  }
});

export default router;
