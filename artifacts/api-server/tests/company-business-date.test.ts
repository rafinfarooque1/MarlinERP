import assert from "node:assert/strict";
import { companyTodayISO, dateISOInTimeZone } from "../src/lib/books";

const query = async (sql: string) => {
  assert.match(sql, /SELECT general_settings FROM company_settings/);
  return { rows: [{ general_settings: { timeZone: "Asia/Kolkata" } }] };
};

const db = { query };
assert.equal(
  dateISOInTimeZone(new Date("2026-10-23T18:45:00.000Z"), "Asia/Kolkata"),
  "2026-10-24",
  "A UTC evening after midnight in India must use the company's next business date.",
);
assert.equal(
  await companyTodayISO(db as any, new Date("2026-10-23T18:45:00.000Z")),
  "2026-10-24",
  "The configured company timezone must determine the valuation cutoff date.",
);

console.log("company-business-date: valuation date uses the configured company timezone");
