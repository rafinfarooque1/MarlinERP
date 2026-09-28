import { nextVoucherNumber, type Queryable } from "./voucherNumber";

export interface SalaryAccrualJournalInput {
  employeeId: number;
  employeeName: string;
  accrualDate: string;
  amount: number;
  expenseLedgerId: number;
  payableLedgerId: number;
  locationType: string;
  locationId: number;
}

export type SalaryAccrualJournalBalances = Map<
  string,
  Map<string, { locationType: string; locationId: number; amount: number }>
>;

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const locationKey = (type: string, id: number) => `${type}:${id}`;

/** Load all signed source postings once for an employee's accrual sweep. */
export async function loadSalaryAccrualJournalBalances(
  q: Queryable,
  employeeId: number,
  throughDate: string,
): Promise<SalaryAccrualJournalBalances> {
  const { rows } = await q.query(
    `SELECT to_char(accrual_date, 'YYYY-MM-DD') AS accrual_date,
            location_type, location_id, SUM(signed_amount) AS amount
       FROM salary_accrual_journal_links
      WHERE employee_id = $1 AND accrual_date <= $2
      GROUP BY accrual_date, location_type, location_id`,
    [employeeId, throughDate],
  );
  const balances: SalaryAccrualJournalBalances = new Map();
  for (const row of rows) {
    const date = String(row.accrual_date);
    const locationType = String(row.location_type ?? "headoffice");
    const locationId = Number(row.location_id ?? 0);
    let byLocation = balances.get(date);
    if (!byLocation) {
      byLocation = new Map();
      balances.set(date, byLocation);
    }
    byLocation.set(locationKey(locationType, locationId), {
      locationType, locationId, amount: round2(Number(row.amount ?? 0)),
    });
  }
  return balances;
}

/**
 * Make the actual journal-voucher stream equal the current attendance accrual.
 * Corrections are append-only signed adjustments; no prior voucher is edited or
 * deleted. Call inside the employee accrual transaction/lock.
 */
export async function syncSalaryAccrualJournal(
  q: Queryable,
  input: SalaryAccrualJournalInput,
  knownBalances?: SalaryAccrualJournalBalances,
): Promise<void> {
  const desired = round2(input.amount);
  const desiredLocationId = input.locationType === "headoffice" ? 0 : input.locationId;
  const desiredKey = locationKey(input.locationType, desiredLocationId);
  let balances = knownBalances?.get(input.accrualDate);
  if (!balances) {
    balances = new Map();
    if (!knownBalances) {
      const { rows } = await q.query(
        `SELECT location_type, location_id, COALESCE(SUM(signed_amount), 0) AS amount
           FROM salary_accrual_journal_links
          WHERE employee_id = $1 AND accrual_date = $2
          GROUP BY location_type, location_id`,
        [input.employeeId, input.accrualDate],
      );
      for (const row of rows) {
        const locationType = String(row.location_type ?? "headoffice");
        const locationId = Number(row.location_id ?? 0);
        balances.set(locationKey(locationType, locationId), {
          locationType, locationId, amount: round2(Number(row.amount ?? 0)),
        });
      }
    } else {
      knownBalances.set(input.accrualDate, balances);
    }
  }
  if (!balances.has(desiredKey)) {
    balances.set(desiredKey, {
      locationType: input.locationType, locationId: desiredLocationId, amount: 0,
    });
  }

  for (const [key, balance] of balances) {
    const target = key === desiredKey ? desired : 0;
    const delta = round2(target - balance.amount);
    if (Math.abs(delta) < 0.005) continue;

    const positive = delta > 0;
    const amount = Math.abs(delta).toFixed(2);
    const voucherNumber = await nextVoucherNumber(q, "journal", input.accrualDate);
    const action = balance.amount === 0
      ? "Attendance salary accrual"
      : "Attendance salary accrual adjustment";
    const narration = `${action} — ${input.employeeName} — ${input.accrualDate}`;
    const { rows: [voucher] } = await q.query(
      `INSERT INTO journal_vouchers
         (voucher_type, voucher_number, voucher_date, narration, total_amount, created_by,
          origin, source_module, location_type, location_id)
       VALUES ('journal', $1, $2, $3, $4, 'system', 'system', 'salary_accrual', $5, $6)
       RETURNING id`,
      [
        voucherNumber, input.accrualDate, narration, amount,
        balance.locationType, balance.locationId,
      ],
    );

    // A negative delta reverses the earlier recognition with the same two ledgers.
    await q.query(
      `INSERT INTO journal_voucher_lines (voucher_id, ledger_id, debit, credit)
       VALUES ($1, $2, $3, $4), ($1, $5, $6, $7)`,
      [
        voucher.id,
        input.expenseLedgerId, positive ? amount : "0", positive ? "0" : amount,
        input.payableLedgerId, positive ? "0" : amount, positive ? amount : "0",
      ],
    );
    await q.query(
      `INSERT INTO salary_accrual_journal_links
         (employee_id, accrual_date, voucher_id, signed_amount, location_type, location_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        input.employeeId, input.accrualDate, voucher.id, delta.toFixed(2),
        balance.locationType, balance.locationId,
      ],
    );
    balance.amount = round2(balance.amount + delta);
  }
}