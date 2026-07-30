/**
 * Renders a party's current balance with its side.
 *
 * Vendor and customer balances are signed to the account's natural side: a
 * vendor's positive balance is a credit (we owe them), a customer's positive
 * balance is a debit (they owe us). A negative balance is not nothing — it is
 * an advance sitting on the wrong side, and the ERP used to clamp those to zero
 * with `GREATEST(0, …)`, which quietly hid money already paid out. Abnormal
 * balances are shown, labelled, never suppressed.
 */
export function PartyBalance({
  kind,
  balance,
  className = '',
}: {
  kind: 'vendor' | 'customer';
  balance: unknown;
  className?: string;
}) {
  // No ledger was provisioned for this party, so there is no balance to state.
  // Rendering ₹0.00 here would read as "settled in full", which is a different
  // claim entirely.
  if (balance == null || balance === '' || Number.isNaN(Number(balance))) {
    return (
      <span
        className={`font-mono text-muted-foreground ${className}`}
        title="No account ledger for this party — re-save it to create one"
      >—</span>
    );
  }

  const n = Number(balance);
  const amount = Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  if (Math.abs(n) < 0.005) {
    return <span className={`font-mono text-muted-foreground ${className}`}>₹0.00</span>;
  }

  // Normal side: vendor = we owe, customer = they owe.
  if (n > 0) {
    return (
      <span className={`font-mono font-semibold ${kind === 'vendor' ? 'text-amber-600' : 'text-primary'} ${className}`}>
        ₹{amount}
      </span>
    );
  }

  // Abnormal side — an advance.
  const title = kind === 'vendor'
    ? 'Advance paid — this vendor holds our money'
    : 'Advance received — we hold this customer\'s money';
  return (
    <span className={`font-mono font-semibold text-sky-600 ${className}`} title={title}>
      ₹{amount}
      <span className="ml-1 text-[10px] uppercase tracking-wide font-sans opacity-80">Adv</span>
    </span>
  );
}
