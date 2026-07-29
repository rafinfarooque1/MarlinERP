/**
 * Secure invoice share links.
 *
 * A link is server-owned state, not a string the client can build: it has a
 * status, a fixed expiry date and a use count, and it can be revoked. The client
 * asks for the current one, asks for a fresh one, or kills it — it never mints or
 * signs anything itself.
 *
 * `path` is relative on purpose. The server does not know which host the customer
 * will be sent to, so the caller makes it absolute against its own origin.
 */
import { useMutation, useQuery, UseQueryOptions } from "@tanstack/react-query";
import { customFetch } from "./custom-fetch";

export type InvoiceShareLinkStatus = "active" | "expired" | "revoked";

export interface InvoiceShareLink {
  publicId: string;
  status: InvoiceShareLinkStatus;
  /** Relative URL of the customer-facing page. Null unless the link is active. */
  path: string | null;
  createdAt: string;
  expiresAt: string;
  accessCount: number;
  lastAccessAt: string | null;
  revokedAt: string | null;
  validForDays: number;
}

export interface InvoiceShareLinkState {
  saleId: number;
  customerPhone: string | null;
  /** Null when this invoice has never been shared. */
  link: InvoiceShareLink | null;
}

export interface InvoiceShareLinkResult {
  saleId: number;
  /** True when an existing active link was handed back instead of a new one. */
  reused: boolean;
  link: InvoiceShareLink;
}

/** Why a link is being requested. 'whatsapp' is recorded as a share, not just a generate. */
export type ShareIntent = "link" | "whatsapp";

// ── Plain callers ───────────────────────────────────────────────────────────
// Exposed as functions as well as hooks: sharing is triggered from click handlers
// that are not React state transitions, and a handler that has to wait for a
// mutation's onSuccess loses the user gesture the popup blocker needs.

/** Reuse the active link, or mint one. `intent` decides how it is audited. */
export const ensureInvoiceShareLink = (
  saleId: number, intent: ShareIntent = "link",
): Promise<InvoiceShareLinkResult> =>
  customFetch<InvoiceShareLinkResult>(`/api/sales/${saleId}/share-link`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ intent }),
  });

export const regenerateInvoiceShareLink = (saleId: number): Promise<InvoiceShareLinkResult> =>
  customFetch<InvoiceShareLinkResult>(`/api/sales/${saleId}/share-link/regenerate`, { method: "POST" });

export const revokeInvoiceShareLink = (
  saleId: number,
): Promise<{ saleId: number; link: InvoiceShareLink }> =>
  customFetch<{ saleId: number; link: InvoiceShareLink }>(
    `/api/sales/${saleId}/share-link/revoke`, { method: "POST" },
  );

// ── Hooks ───────────────────────────────────────────────────────────────────

export const getInvoiceShareLinkQueryKey = (saleId: number | null | undefined) =>
  ["/api/sales/share-link", saleId] as const;

/** Current link state for an invoice. Read-only — never creates a link. */
export const useInvoiceShareLink = (
  saleId: number | null | undefined,
  options?: { query?: Omit<UseQueryOptions<InvoiceShareLinkState, Error>, "queryKey"> },
) =>
  useQuery<InvoiceShareLinkState, Error>({
    queryKey: getInvoiceShareLinkQueryKey(saleId),
    queryFn: () => customFetch<InvoiceShareLinkState>(`/api/sales/${saleId}/share-link`),
    enabled: saleId != null,
    ...options?.query,
  });

/** Reuse the active link, or mint one if there isn't a usable one. */
export const useEnsureInvoiceShareLink = () =>
  useMutation<InvoiceShareLinkResult, Error, { saleId: number; intent?: ShareIntent }>({
    mutationFn: ({ saleId, intent = "link" }) => ensureInvoiceShareLink(saleId, intent),
  });

/** Revoke the current link and issue a new one in its place. */
export const useRegenerateInvoiceShareLink = () =>
  useMutation<InvoiceShareLinkResult, Error, { saleId: number }>({
    mutationFn: ({ saleId }) => regenerateInvoiceShareLink(saleId),
  });

/** Kill the current link. Anyone holding the URL loses access immediately. */
export const useRevokeInvoiceShareLink = () =>
  useMutation<{ saleId: number; link: InvoiceShareLink }, Error, { saleId: number }>({
    mutationFn: ({ saleId }) => revokeInvoiceShareLink(saleId),
  });

/** Absolute link to hand to a customer, from a relative server path. */
export const absoluteShareUrl = (path: string): string =>
  typeof window === "undefined" ? path : new URL(path, window.location.origin).toString();
