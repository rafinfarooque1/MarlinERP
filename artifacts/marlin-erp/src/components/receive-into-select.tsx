import { useMemo } from 'react';
import { useCashBankLedgersFlat, useVoucherLocations } from '@workspace/api-client-react';
import { AccountCombobox, type AccountOption } from '@/components/ui/account-combobox';

export type ReceiveIntoOption = AccountOption & {
  /** cash / bank / upi when backed by a Cash & Bank account row; null for tills. */
  accountType?: string | null;
};

/** Best client-side guess at whether an account is cash-like — mirrors the
 * server's derivation (account type first, cash-tree membership otherwise,
 * approximated here by the till/cash code convention). Display-only. */
export function isCashOption(o: ReceiveIntoOption | undefined): boolean {
  if (!o) return false;
  if (o.accountType) return o.accountType === 'cash';
  return (o.code ?? '').toUpperCase().includes('CASH');
}

/**
 * "Receive Into" — the ONE destination selector for every customer collection
 * screen. Lists the real Cash & Bank accounts of the SALE's location (its cash
 * till plus any bank/UPI/cash accounts assigned to it), exactly like the
 * account picker on the Vendor Payment screen. The server derives the
 * cash/bank/UPI method from the picked account, so no method dropdown exists.
 *
 * Head Office sales use the head-office set; its placeholder location id
 * differs per table (sales use 1, vouchers 0), so HO is matched on TYPE alone.
 */
export function useReceiveIntoOptions(
  locationType?: string | null,
  locationId?: number | null,
): { options: ReceiveIntoOption[]; isLoading: boolean } {
  const { data: ledgers, isLoading: l1 } = useCashBankLedgersFlat();
  const { data: vlocs, isLoading: l2 } = useVoucherLocations();
  const options = useMemo(() => {
    if (!ledgers || !vlocs) return [];
    const lt = locationType || 'outlet';
    const loc = (vlocs.locations ?? []).find(l =>
      l.locationType === lt &&
      (lt === 'headoffice' || Number(l.locationId) === Number(locationId ?? 0)));
    if (!loc) return [];
    const allow = new Set((loc.cashBankLedgerIds ?? []).map(Number));
    return (ledgers as any[])
      .filter(l => allow.has(Number(l.id)))
      .map(l => ({ id: Number(l.id), name: l.name as string, code: l.code ?? null, accountType: l.accountType ?? null }));
  }, [ledgers, vlocs, locationType, locationId]);
  return { options, isLoading: l1 || l2 };
}

export function ReceiveIntoSelect({
  locationType, locationId, value, onChange, disabled, className, compact,
}: {
  locationType?: string | null;
  locationId?: number | null;
  value: number; // 0 = nothing selected
  onChange: (id: number) => void;
  disabled?: boolean;
  className?: string;
  /** h-8 text-sm trigger for dense panels */
  compact?: boolean;
}) {
  const { options, isLoading } = useReceiveIntoOptions(locationType, locationId);
  return (
    <AccountCombobox
      options={options}
      value={value}
      onChange={onChange}
      placeholder={isLoading ? 'Loading accounts…' : 'Select Cash / Bank account'}
      disabled={disabled}
      className={`${compact ? 'h-8 text-sm' : ''} ${className ?? ''}`.trim() || undefined}
      data-testid="select-receive-into"
    />
  );
}
