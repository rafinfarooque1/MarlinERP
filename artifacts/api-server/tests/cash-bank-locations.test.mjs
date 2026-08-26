/**
 * Cash/Bank account availability regression.
 *
 * Read-only: this suite creates, edits and deletes no business data. It proves
 * that an account is emitted once with one scalar owner, and that a
 * one-or-more-location filter narrows accounts without duplicating them.
 *
 * Required environment: TEST_USERNAME and TEST_PASSWORD.
 * Run: node artifacts/api-server/tests/cash-bank-locations.test.mjs
 */
const BASE = process.env.API_URL || "http://localhost:8080/api";
const username = process.env.TEST_USERNAME;
const password = process.env.TEST_PASSWORD;

if (!username || !password) {
  console.error("TEST_USERNAME and TEST_PASSWORD are required; refusing to guess credentials.");
  process.exit(2);
}

let token = "";
let passed = 0;
let failed = 0;

function assert(label, condition, detail = "") {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

async function request(path) {
  const response = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, data };
}

function keyOf(account) {
  return `${account.locationType}:${account.locationType === "headoffice" ? 0 : account.locationId}`;
}

async function login() {
  const response = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const data = await response.json();
  token = data.token;
  if (!token) throw new Error("login failed");
}

async function run() {
  await login();
  const all = await request("/accounts/cash-bank");
  assert("consolidated Cash/Bank list responds", all.status === 200);
  assert("Cash/Bank response is an array", Array.isArray(all.data));

  const accountIds = new Set();
  for (const account of all.data ?? []) {
    const id = Number(account.id);
    assert(`account ${id} appears once`, !accountIds.has(id));
    accountIds.add(id);
    assert(`account ${id} has one canonical location`, ["headoffice", "warehouse", "outlet"].includes(account.locationType));
    assert(`account ${id} has a canonical location id`, Number.isInteger(Number(account.locationId)));
    assert(`account ${id} does not expose multi-location availability`, account.locations === undefined);
    assert(`account ${id} has numeric ledger balance`, Number.isFinite(Number(account.balance)));
  }

  const mapped = (all.data ?? []).find((account) => ["headoffice", "warehouse", "outlet"].includes(account.locationType));
  if (!mapped) {
    console.log("  • No Cash/Bank account is available to exercise the location filter.");
  } else {
    const selected = keyOf(mapped);
    const narrowed = await request(`/accounts/cash-bank?locationKeys=${encodeURIComponent(selected)}`);
    assert("location-filtered Cash/Bank list responds", narrowed.status === 200);
    assert("location-filtered response is an array", Array.isArray(narrowed.data));
    const selectedKeys = new Set(selected.split(","));
    for (const account of narrowed.data ?? []) {
      const matches = selectedKeys.has(keyOf(account));
      assert(`filtered account ${account.id} is available at a selected location`, matches);
      assert(`filtered account ${account.id} remains unique`, !accountIds.has(`filtered:${account.id}`));
      accountIds.add(`filtered:${account.id}`);
      assert(`filtered account ${account.id} has numeric posting-slice balance`, Number.isFinite(Number(account.balance)));
    }
  }

  const ledgerBacked = (all.data ?? []).find((account) => Number.isInteger(Number(account.ledgerId)) && Number(account.ledgerId) > 0);
  if (ledgerBacked) {
    const statement = await request(`/accounts/ledger-statement?accountId=${ledgerBacked.ledgerId}`);
    assert("ledger statement responds", statement.status === 200);
    for (const entry of statement.data?.entries ?? []) {
      assert("ledger entry carries narration", typeof entry.narration === "string");
      assert("ledger entry carries a location type field", Object.hasOwn(entry, "locationType"));
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});