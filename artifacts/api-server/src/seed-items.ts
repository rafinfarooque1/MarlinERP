/**
 * Seed script: inserts all Marlin Frozen Fruits catalog items from the product brochure.
 * Run once: pnpm --filter @workspace/api-server tsx src/seed-items.ts
 */

import { db, itemsTable } from "@workspace/db";

const ITEMS = [
  // ── Frozen Fruit Slices & Dices ──────────────────────────────────────────
  { name: "Pomegranate Slices",            hsnCode: "08119000", taxRate: "5",  unit: "pkt", description: "Frozen Fruit Slices" },
  { name: "Apricot Slices",               hsnCode: "08119000", taxRate: "5",  unit: "pkt", description: "Frozen Fruit Slices" },
  { name: "Avocado Slices",               hsnCode: "08119000", taxRate: "5",  unit: "pkt", description: "Frozen Fruit Slices" },
  { name: "Black Grapes (Frozen)",         hsnCode: "08119000", taxRate: "5",  unit: "pkt", description: "Frozen Fruit Slices" },
  { name: "Dragon Fruit Dices (Red)",      hsnCode: "08119000", taxRate: "5",  unit: "pkt", description: "Frozen Fruit Slices" },
  { name: "Dragon Fruit Dices (White)",    hsnCode: "08119000", taxRate: "5",  unit: "pkt", description: "Frozen Fruit Slices" },
  { name: "Guava Slices (Red)",            hsnCode: "08119000", taxRate: "5",  unit: "pkt", description: "Frozen Fruit Slices" },
  { name: "Jackfruit Slices",             hsnCode: "08119000", taxRate: "5",  unit: "pkt", description: "Frozen Fruit Slices" },
  { name: "Kiwi Slices",                  hsnCode: "08119000", taxRate: "5",  unit: "pkt", description: "Frozen Fruit Slices" },
  { name: "Litchi Slices",               hsnCode: "08119000", taxRate: "5",  unit: "pkt", description: "Frozen Fruit Slices" },
  { name: "Mango Slices (Alphonso)",       hsnCode: "08119000", taxRate: "5",  unit: "pkt", description: "Frozen Fruit Slices" },
  { name: "Mango Slices (Kesar)",          hsnCode: "08119000", taxRate: "5",  unit: "pkt", description: "Frozen Fruit Slices" },
  { name: "Papaya Dices",                  hsnCode: "08119000", taxRate: "5",  unit: "pkt", description: "Frozen Fruit Slices" },
  { name: "Pineapple Dices",              hsnCode: "08119000", taxRate: "5",  unit: "pkt", description: "Frozen Fruit Slices" },
  { name: "Watermelon Dices",             hsnCode: "08119000", taxRate: "5",  unit: "pkt", description: "Frozen Fruit Slices" },
  { name: "Shredded Coconut (Frozen)",     hsnCode: "08119000", taxRate: "5",  unit: "pkt", description: "Frozen Fruit Slices" },
  { name: "Strawberry Slices",            hsnCode: "08119000", taxRate: "5",  unit: "pkt", description: "Frozen Fruit Slices" },
  { name: "Plum Slices",                  hsnCode: "08119000", taxRate: "5",  unit: "pkt", description: "Frozen Fruit Slices" },
  { name: "Atis (Sugar Apple) Slices",    hsnCode: "08119000", taxRate: "5",  unit: "pkt", description: "Frozen Fruit Slices" },
  { name: "Shredded Coconut Kernel Slices", hsnCode: "08119000", taxRate: "5", unit: "pkt", description: "Frozen Fruit Slices" },
  { name: "Anjeer (Fig) Slices",          hsnCode: "08119000", taxRate: "5",  unit: "pkt", description: "Frozen Fruit Slices" },
  { name: "Custard Apple Slices",         hsnCode: "08119000", taxRate: "5",  unit: "pkt", description: "Frozen Fruit Slices" },
  { name: "Lychee Slices",               hsnCode: "08119000", taxRate: "5",  unit: "pkt", description: "Frozen Fruit Slices" },
  { name: "Chikoo (Sapota) Slices",       hsnCode: "08119000", taxRate: "5",  unit: "pkt", description: "Frozen Fruit Slices" },
  { name: "Jamun Slices",                hsnCode: "08119000", taxRate: "5",  unit: "pkt", description: "Frozen Fruit Slices" },

  // ── Tender Coconut Products ───────────────────────────────────────────────
  { name: "Tender Coconut Thick Milk Shake Mix", hsnCode: "20089200", taxRate: "12", unit: "pkt", description: "Tender Coconut product" },
  { name: "Tender Coconut Kernel Pulp",   hsnCode: "20089200", taxRate: "12", unit: "pkt", description: "Tender Coconut Pulp" },

  // ── Fruit Pulp ────────────────────────────────────────────────────────────
  { name: "Avocado Pulp",                 hsnCode: "20079910", taxRate: "12", unit: "pkt", description: "Fruit Pulp" },
  { name: "Chikoo Pulp",                  hsnCode: "20079910", taxRate: "12", unit: "pkt", description: "Fruit Pulp" },
  { name: "Guava Pulp (Red)",              hsnCode: "20079910", taxRate: "12", unit: "pkt", description: "Fruit Pulp" },
  { name: "Guava Pulp (White)",            hsnCode: "20079910", taxRate: "12", unit: "pkt", description: "Fruit Pulp" },
  { name: "Jamun Pulp",                   hsnCode: "20079910", taxRate: "12", unit: "pkt", description: "Fruit Pulp" },
  { name: "Mango Pulp (Alphonso)",         hsnCode: "20079910", taxRate: "12", unit: "pkt", description: "Fruit Pulp" },
  { name: "Mango Pulp (Kesar)",            hsnCode: "20079910", taxRate: "12", unit: "pkt", description: "Fruit Pulp" },
  { name: "Passion Fruit Pulp",           hsnCode: "20079910", taxRate: "12", unit: "pkt", description: "Fruit Pulp" },
  { name: "Pineapple Pulp",               hsnCode: "20079910", taxRate: "12", unit: "pkt", description: "Fruit Pulp" },
  { name: "Pomegranate Pulp",             hsnCode: "20079910", taxRate: "12", unit: "pkt", description: "Fruit Pulp" },
  { name: "Custard Apple Pulp",           hsnCode: "20079910", taxRate: "12", unit: "pkt", description: "Fruit Pulp" },
  { name: "Anjeer (Fig) Pulp",            hsnCode: "20079910", taxRate: "12", unit: "pkt", description: "Fruit Pulp" },

  // ── Frozen Imported & Indian Berries ─────────────────────────────────────
  { name: "Mix Berry",                    hsnCode: "08112000", taxRate: "0",  unit: "pkt", description: "Frozen Berries - Imported & Indian" },
  { name: "Strawberry Dices",             hsnCode: "08112000", taxRate: "0",  unit: "pkt", description: "Frozen Berries" },
  { name: "Strawberry Scooped",           hsnCode: "08112000", taxRate: "0",  unit: "pkt", description: "Frozen Berries" },
  { name: "Strawberry Whole",             hsnCode: "08112000", taxRate: "0",  unit: "pkt", description: "Frozen Berries" },
  { name: "Sweet Cherry",                 hsnCode: "08112000", taxRate: "0",  unit: "pkt", description: "Frozen Berries - Imported" },
  { name: "Mulberry",                     hsnCode: "08112000", taxRate: "0",  unit: "pkt", description: "Frozen Berries - Indian" },
  { name: "Cranberry",                    hsnCode: "08112000", taxRate: "0",  unit: "pkt", description: "Frozen Berries - Imported" },
  { name: "Redcurrant",                   hsnCode: "08112000", taxRate: "0",  unit: "pkt", description: "Frozen Berries - Imported" },
  { name: "Blackberry",                   hsnCode: "08112000", taxRate: "0",  unit: "pkt", description: "Frozen Berries - Imported" },
  { name: "Blueberry",                    hsnCode: "08112000", taxRate: "0",  unit: "pkt", description: "Frozen Berries - Imported" },
];

async function seed() {
  console.log(`Seeding ${ITEMS.length} items from the Marlin product brochure…`);
  let inserted = 0;
  let skipped = 0;

  for (const item of ITEMS) {
    try {
      await db.insert(itemsTable).values(item).onConflictDoNothing();
      inserted++;
      console.log(`  ✓ ${item.name}`);
    } catch (err: any) {
      console.warn(`  ⚠ Skipped "${item.name}": ${err.message}`);
      skipped++;
    }
  }

  console.log(`\nDone — ${inserted} inserted, ${skipped} skipped (already exist).`);
  process.exit(0);
}

seed().catch(err => { console.error(err); process.exit(1); });
