/**
 * Normalize legacy sales invoice numbers at display boundaries only.
 *
 * Stored numbers remain the identity used by accounting, search, and settlement.
 * Only the B2B/B2C sales series are reformatted; other document references pass
 * through unchanged.
 */
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