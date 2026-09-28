const round2 = (amount: number) => Math.round((amount + Number.EPSILON) * 100) / 100;

/**
 * One effective daily basic-pay rate for accrual, payroll, and production cost.
 * A configured daily wage is already a per-day amount; legacy employees with a
 * NULL daily wage continue to use monthly salary divided by the calendar-month
 * basis without rounding the rate first.
 */
export function effectiveDailyBasicRate(
  monthlySalary: number,
  dailyWage: number | null | undefined,
  workingDays: number,
): number {
  return dailyWage == null
    ? (workingDays > 0 ? monthlySalary / workingDays : 0)
    : Number(dailyWage);
}

/** Monthly equivalent stored on a payroll row for the month's calendar basis. */
export function effectiveMonthlyBasic(
  monthlySalary: number,
  dailyWage: number | null | undefined,
  workingDays: number,
): number {
  return dailyWage == null
    ? monthlySalary
    : round2(Number(dailyWage) * workingDays);
}