/** Display-only date formatting; date-only database values stay timezone-safe. */
export function formatDisplayDate(value: string | number | Date | null | undefined): string {
  if (value == null || value === "") return "";

  let day: number;
  let month: number;
  let year: number;
  if (typeof value === "string") {
    const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (dateOnly) {
      year = Number(dateOnly[1]);
      month = Number(dateOnly[2]);
      day = Number(dateOnly[3]);
    } else {
      const parsed = new Date(value);
      if (Number.isNaN(parsed.getTime())) return "";
      day = parsed.getDate();
      month = parsed.getMonth() + 1;
      year = parsed.getFullYear();
    }
  } else {
    const parsed = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(parsed.getTime())) return "";
    day = parsed.getDate();
    month = parsed.getMonth() + 1;
    year = parsed.getFullYear();
  }

  return `${String(day).padStart(2, "0")}-${String(month).padStart(2, "0")}-${String(year).slice(-2)}`;
}