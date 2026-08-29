import { useQuery } from "@tanstack/react-query";
import { customFetch } from "./custom-fetch";

export type VoucherPartyKind = "customer" | "vendor";

export interface VoucherPartyLocation {
  locationType: "headoffice" | "warehouse" | "outlet";
  locationId: number;
}

export interface VoucherPartyLedger {
  ledgerId: number;
  partyId: number;
  name: string;
  code: string;
  locationType: string | null;
  locationId: number | null;
}

/**
 * Fetch only the party ledgers valid for the selected voucher location.
 * The server applies both this location filter and the caller's LBAC scope.
 */
export function useVoucherPartyLedgers(
  kind: VoucherPartyKind,
  location?: VoucherPartyLocation,
) {
  const params = new URLSearchParams({ kind });
  if (location) {
    params.set("locationType", location.locationType);
    if (location.locationType !== "headoffice") {
      params.set("locationId", String(location.locationId));
    }
  }
  const suffix = params.toString();

  return useQuery({
    queryKey: ["/api/accounts/voucher-parties", kind, location?.locationType ?? null, location?.locationId ?? null],
    enabled: Boolean(location),
    queryFn: ({ signal }) =>
      customFetch<VoucherPartyLedger[]>(`/api/accounts/voucher-parties?${suffix}`, { signal }),
  });
}