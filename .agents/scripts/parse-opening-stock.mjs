// Parses the uploaded opening-stock PDF into structured rows and validates the
// parse against the document's own printed totals. Read-only: writes a JSON
// preview to .agents/outputs/ and never touches any database.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const pdf = process.argv[2];
if (!pdf) throw new Error('usage: node parse-opening-stock.mjs <file.pdf>');

const text = execFileSync('pdftotext', ['-layout', pdf, '-'], { encoding: 'utf8' });
const lines = text.split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim());

// Columns: Itemname | HSN | Qty | Unit? | Cost | Total Value | MRP | MFG date
const ROW = /^(.*?)\s{2,}(\d{4,8})\s+([\d,]+(?:\.\d+)?)\s+(?:([A-Za-z]+)\s+)?([\d,]+\.\d{2})\s+([\d,]+\.\d{2})\s+([\d,]+(?:\.\d+)?)\s+(\d{1,2}-[A-Za-z]{3}-\d{2})$/;
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const num = (s) => Number(String(s).replace(/,/g, ''));

// MFG + 18 calendar months. Clamp to the last day of the target month so that
// e.g. 31-Aug + 18m yields 28/29-Feb rather than rolling into March.
function addMonths(y, m, d, months) {
  const total = m + months;
  const ny = y + Math.floor(total / 12);
  const nm = ((total % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return { y: ny, m: nm, d: Math.min(d, lastDay) };
}
const iso = ({ y, m, d }) => `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

const rows = [];
const unparsed = [];
let printedTotals = null;

for (const line of lines) {
  if (/^Itemname/i.test(line)) continue;
  // Trailing totals line: "<qty> <value>" with no item name.
  const totals = line.match(/^\s+([\d,]+)\s+([\d,]+\.\d{2})\s*$/);
  if (totals) { printedTotals = { qty: num(totals[1]), value: num(totals[2]) }; continue; }

  const m = line.match(ROW);
  if (!m) { unparsed.push(line); continue; }

  const [, name, hsn, qty, unit, cost, total, mrp, mfg] = m;
  const [dd, mon, yy] = mfg.split('-');
  const mi = MONTHS[mon.toLowerCase()];
  if (mi === undefined) { unparsed.push(line); continue; }
  const year = 2000 + Number(yy);
  const mfgParts = { y: year, m: mi, d: Number(dd) };

  rows.push({
    sourceName: name.trim(),
    hsnCode: hsn,
    qty: num(qty),
    unit: unit ? unit.toLowerCase() : null,
    cost: num(cost),
    totalValue: num(total),
    mrp: num(mrp),
    mfgDate: iso(mfgParts),
    expiryDate: iso(addMonths(mfgParts.y, mfgParts.m, mfgParts.d, 18)),
    lineValueMatches: Math.abs(num(qty) * num(cost) - num(total)) <= 1.0,
  });
}

const sum = (f) => rows.reduce((a, r) => a + f(r), 0);
const report = {
  sourceFile: pdf,
  parsedRows: rows.length,
  unparsedLines: unparsed,
  printedTotals,
  computed: { qty: sum((r) => r.qty), value: Number(sum((r) => r.totalValue).toFixed(2)) },
  missingUnit: rows.filter((r) => !r.unit).map((r) => r.sourceName),
  missingMfg: rows.filter((r) => !r.mfgDate).map((r) => r.sourceName),
  missingCost: rows.filter((r) => !(r.cost > 0)).map((r) => r.sourceName),
  lineValueMismatches: rows.filter((r) => !r.lineValueMatches).map((r) => ({ name: r.sourceName, qty: r.qty, cost: r.cost, stated: r.totalValue, computed: Number((r.qty * r.cost).toFixed(2)) })),
  duplicateNames: Object.entries(rows.reduce((a, r) => { const k = r.sourceName.toUpperCase().replace(/\s+/g, ' '); a[k] = (a[k] || 0) + 1; return a; }, {})).filter(([, n]) => n > 1).map(([k]) => k),
  shortHsn: [...new Set(rows.filter((r) => r.hsnCode.length < 6).map((r) => r.hsnCode))],
  units: [...new Set(rows.map((r) => r.unit))],
  rows,
};

fs.mkdirSync('.agents/outputs', { recursive: true });
fs.writeFileSync('.agents/outputs/opening-stock-parsed.json', JSON.stringify(report, null, 2));

console.log(`parsed rows      : ${report.parsedRows}`);
console.log(`unparsed lines   : ${report.unparsedLines.length}`, report.unparsedLines);
console.log(`printed totals   : qty=${printedTotals?.qty} value=${printedTotals?.value}`);
console.log(`computed totals  : qty=${report.computed.qty} value=${report.computed.value}`);
console.log(`qty matches      : ${printedTotals?.qty === report.computed.qty}`);
console.log(`value matches    : ${Math.abs((printedTotals?.value ?? 0) - report.computed.value) < 1}`);
console.log(`units seen       : ${JSON.stringify(report.units)}`);
console.log(`missing unit     : ${JSON.stringify(report.missingUnit)}`);
console.log(`missing cost     : ${JSON.stringify(report.missingCost)}`);
console.log(`duplicate names  : ${JSON.stringify(report.duplicateNames)}`);
console.log(`short HSN codes  : ${JSON.stringify(report.shortHsn)}`);
console.log(`line-value mismatches (>Re.1):`);
for (const m of report.lineValueMismatches) console.log(`  ${m.name}: ${m.qty} x ${m.cost} = ${m.computed}, stated ${m.stated}`);
console.log(`\nfirst 5 rows:`);
for (const r of rows.slice(0, 5)) console.log(' ', JSON.stringify(r));
