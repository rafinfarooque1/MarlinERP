/**
 * Display-only date formatting.
 *
 * Date-only API values are parsed from their calendar components rather than
 * through Date's UTC parser, so the displayed day cannot shift by timezone.
 * Timestamps and Date/number values retain normal instant semantics.
 */
export type DateLike = string | number | Date | null | undefined;

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

export function formatDateOrDash(value: DateLike): string {
  return formatDate(value) || '—';
}

export function formatDateTime(value: DateLike): string {
  if (value == null || value === '') return '';
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return '';
  const date = formatDate(parsed);
  return `${date} ${parsed.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`;
}