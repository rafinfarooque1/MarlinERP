export type DateLike = string | number | Date | null | undefined;

/** Display dates as DD-MM-YY without shifting date-only ISO strings by timezone. */
export function formatDate(value: DateLike): string {
  if (value == null || value === '') return '';

  let day: number;
  let month: number;
  let year: number;
  if (typeof value === 'string') {
    const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (dateOnly) {
      year = Number(dateOnly[1]);
      month = Number(dateOnly[2]);
      day = Number(dateOnly[3]);
    } else {
      const parsed = new Date(value);
      if (Number.isNaN(parsed.getTime())) return '';
      day = parsed.getDate();
      month = parsed.getMonth() + 1;
      year = parsed.getFullYear();
    }
  } else {
    const parsed = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(parsed.getTime())) return '';
    day = parsed.getDate();
    month = parsed.getMonth() + 1;
    year = parsed.getFullYear();
  }

  return `${String(day).padStart(2, '0')}-${String(month).padStart(2, '0')}-${String(year).slice(-2)}`;
}

export function formatDateTime(value: DateLike): string {
  if (value == null || value === '') return '';
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return '';
  return `${formatDate(parsed)} ${parsed.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`;
}

/** Normalize legacy B2B/B2C sales numbers for display only; never for identity. */
export function formatSalesInvoiceDisplayNumber(value: string | null | undefined): string {
  const raw = String(value ?? '');
  const match = /^(SB2[BC])\/(\d{4}-\d{2}|\d{2}-\d{2})\/(\d+)$/i.exec(raw.trim());
  if (!match) return raw;

  const [, rawSeries, fyLabel, rawSerial] = match;
  const shortFy = fyLabel.length === 7
    ? `${fyLabel.slice(2, 4)}-${fyLabel.slice(5, 7)}`
    : fyLabel;
  const serial = rawSerial.replace(/^0+(?=\d)/, '');
  return `${rawSeries.toUpperCase()}/${shortFy}/${serial}`;
}