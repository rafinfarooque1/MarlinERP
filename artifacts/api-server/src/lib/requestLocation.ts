/**
 * Global location context — server-side transport.
 *
 * The web client attaches the user's selected working location (the sidebar
 * selector) to EVERY API request as headers:
 *
 *   x-location-type: warehouse | outlet | headoffice | all
 *   x-location-id:   <number>            (warehouse/outlet only)
 *
 * Routes that support location narrowing read the merged filter through
 * getLocationFilter / getPostingLocationFilter:
 *
 *  - Explicit query params win over the header context, so pages that already
 *    pass locationType/locationId keep their exact behaviour. The presence of
 *    a locationType query KEY is what selects the query source — a present
 *    but malformed query value degrades to "no narrowing" (per queryFilters
 *    rules), it does NOT fall back to the header.
 *  - 'all', absent, or malformed header values degrade to "no narrowing".
 *  - This is a VIEW request layered on top of LBAC, never authority: routes
 *    keep applying their scope conditions unconditionally, so the header can
 *    only narrow what the caller may already see.
 *
 * WRITE PATHS MUST NEVER READ THIS. A document's location comes from the
 * session or the validated body — not from a display preference that follows
 * the user between screens.
 */
import type { Request } from "express";
import { parseLocationFilter, type ParsedLocationFilter } from "./queryFilters";
import { parsePostingLocationFilter, type PostingLocationFilter } from "./postingLocation";

/** Present the location headers in the same shape the query parsers expect. */
function headerQuery(req: Request): Record<string, unknown> {
  const lt = req.headers["x-location-type"];
  const lid = req.headers["x-location-id"];
  return {
    locationType: typeof lt === "string" ? lt : undefined,
    locationId: typeof lid === "string" ? lid : undefined,
  };
}

function queryHasLocation(req: Request): boolean {
  const lt = (req.query as Record<string, unknown>).locationType;
  return typeof lt === "string" && lt !== "";
}

/** Merged location view-filter for SQL list endpoints (queryFilters shape). */
export function getLocationFilter(req: Request): ParsedLocationFilter | null {
  if (queryHasLocation(req)) return parseLocationFilter(req.query as Record<string, unknown>);
  return parseLocationFilter(headerQuery(req));
}

/** Merged location view-filter for the derived posting stream (adds 'company'). */
export function getPostingLocationFilter(req: Request): PostingLocationFilter | null {
  if (queryHasLocation(req)) return parsePostingLocationFilter(req.query as Record<string, unknown>);
  return parsePostingLocationFilter(headerQuery(req));
}
