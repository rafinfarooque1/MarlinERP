/**
 * Location dimension over the derived posting stream.
 *
 * Every posting carries the location of its SOURCE DOCUMENT (both legs the
 * same stamp), or null when no location can honestly claim it — journal-family
 * vouchers and legacy rows with no stored location. A filter therefore
 * partitions the stream exactly: every posting is in precisely one location
 * slice or in the company-level bucket, so slices + bucket always reconcile
 * to the consolidated figures by construction.
 *
 * Matching rules:
 *  - 'warehouse' / 'outlet' match on type + id.
 *  - 'headoffice' matches on TYPE ALONE — the placeholder id differs per table
 *    (money vouchers store 0, other sources store the employee's branch id),
 *    so matching the id would silently split Head Office into fragments.
 *  - 'company' selects the unattributable postings, so a per-location view can
 *    show them in a labelled bucket instead of dropping them.
 *
 * This is presentation narrowing, NOT authorisation: LBAC gates run before
 * and independently of this filter.
 */

const r2 = (n: number) => Math.round(n * 100) / 100;

export interface PostingLocationFilter {
  type: "warehouse" | "outlet" | "headoffice" | "company";
  id: number | null;
  /**
   * Every (type, id) identity of the SAME physical place. A location can exist
   * as both a warehouse and an outlet sharing one cash ledger ("mirror" rows),
   * and documents at that place carry whichever stamp their module used. A
   * caller that resolves the mirrors (e.g. the import compare pack) passes all
   * identities so postings stamped under either one land in the slice. Absent
   * (every parsed request filter) the match stays exact type + id.
   */
  identities?: Array<{ type: "warehouse" | "outlet"; id: number }>;
}

export interface LocatedPosting {
  locationType: string | null;
  locationId: number | null;
}

/** Parse `?locationType=&locationId=` off a query object; null = no filter. */
export function parsePostingLocationFilter(query: Record<string, unknown>): PostingLocationFilter | null {
  const t = String(query.locationType ?? "");
  if (t === "company") return { type: "company", id: null };
  if (t === "headoffice") return { type: "headoffice", id: null };
  if (t === "warehouse" || t === "outlet") {
    const id = Number(query.locationId);
    if (Number.isFinite(id) && id > 0) return { type: t, id };
  }
  return null;
}

export function postingMatchesLocation(p: LocatedPosting, f: PostingLocationFilter): boolean {
  if (f.type === "company") return p.locationType == null;
  if (f.type === "headoffice") return p.locationType === "headoffice";
  if (f.identities && f.identities.length > 0) {
    return f.identities.some((i) => p.locationType === i.type && Number(p.locationId) === i.id);
  }
  return p.locationType === f.type && Number(p.locationId) === f.id;
}

export function filterPostingsByLocation<T extends LocatedPosting>(
  postings: T[],
  f: PostingLocationFilter | null,
): T[] {
  if (!f) return postings;
  return postings.filter((p) => postingMatchesLocation(p, f));
}

/** Totals of the company-level (unattributable) postings, for the labelled
 *  bucket a location-filtered statement must show rather than drop. */
export function companyLevelSummary(
  postings: Array<{ entryId: string; debit: number; credit: number; locationType: string | null }>,
): { entries: number; debit: number; credit: number } {
  const ids = new Set<string>();
  let debit = 0, credit = 0;
  for (const p of postings) {
    if (p.locationType != null) continue;
    ids.add(p.entryId);
    debit = r2(debit + p.debit);
    credit = r2(credit + p.credit);
  }
  return { entries: ids.size, debit, credit };
}
