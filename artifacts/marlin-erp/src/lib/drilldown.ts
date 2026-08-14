/**
 * Books drill-down — maps a derived-posting provenance key to the page that
 * owns the source document.
 *
 * Every posting the books derive carries an entry key from
 * buildDerivedPostings(): "sale:12", "payment:9", "jv:7",
 * "opening-balance-3"… The ledger statement and the day book expose it so a
 * statement row can open the document it came from. Rows whose figures are
 * DERIVED (daily rent/salary accruals, advance adjustments folded into a
 * bill's settlement) have no standalone document — those resolve to a human
 * explanation instead of a dead click.
 *
 * Navigation uses query params the target pages watch on mount:
 *   /headoffice/sales?view=<saleId>
 *   /production/purchase?view=<purchaseId>
 *   /accounts/vouchers?kind=<voucherType>&view=<id>
 * Target pages keep their own permission gates — a user who can read the
 * books but not open sales lands on the target's Access Denied, which is the
 * existing authority, not a new one.
 */

export type DrillTarget =
  | { kind: 'link'; href: string; label: string }
  | { kind: 'info'; reason: string };

/** JV voucher types the Vouchers page knows how to filter on. */
const JV_TYPES = new Set(['journal', 'contra', 'credit_note', 'debit_note']);

/**
 * @param entryId provenance key ("sale:12", "jv:7", "opening-balance-3"…)
 * @param source  the posting's source label — for "jv:*" keys it carries the
 *                voucher type (journal/contra/credit_note/debit_note).
 */
export function resolveDrill(
  entryId: string | null | undefined,
  source?: string | null,
): DrillTarget | null {
  if (!entryId) return null;

  if (entryId.startsWith('opening-balance')) {
    return {
      kind: 'info',
      reason:
        'Opening balance — a configured starting figure, not a transaction. Manage it under Accounts → Chart of Accounts.',
    };
  }

  const sep = entryId.indexOf(':');
  if (sep < 0) return null;
  const prefix = entryId.slice(0, sep);
  const id = Number(entryId.slice(sep + 1));
  if (!Number.isFinite(id) || id <= 0) return null;

  switch (prefix) {
    case 'sale':
      return { kind: 'link', href: `/headoffice/sales?view=${id}`, label: 'Open sale invoice' };
    case 'purchase':
      return { kind: 'link', href: `/production/purchase?view=${id}`, label: 'Open purchase bill' };
    case 'payment':
      return { kind: 'link', href: `/accounts/vouchers?kind=payment&view=${id}`, label: 'Open payment voucher' };
    case 'receipt':
    case 'receiptadv':
      return { kind: 'link', href: `/accounts/vouchers?kind=receipt&view=${id}`, label: 'Open receipt voucher' };
    case 'jv': {
      const t = source && JV_TYPES.has(source) ? source : 'journal';
      return { kind: 'link', href: `/accounts/vouchers?kind=${t}&view=${id}`, label: 'Open voucher' };
    }
    case 'expense':
      return {
        kind: 'info',
        reason:
          'Head Office expense record — its entry screen has been retired; the figures live on in the books and reports.',
      };
    case 'purchadv':
      return {
        kind: 'info',
        reason:
          'Vendor advance adjusted against a purchase bill — derived from the bill\'s settlement, there is no separate voucher document.',
      };
    case 'rent':
      return {
        kind: 'info',
        reason:
          'Daily warehouse rent accrual — posted automatically from the warehouse\'s rent settings; there is no voucher document.',
      };
    case 'salary':
      return {
        kind: 'info',
        reason:
          'Daily salary accrual — posted automatically from attendance; see HR → Payroll for the underlying run.',
      };
    default:
      return null;
  }
}
