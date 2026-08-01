---
name: Login lockout & identity
description: Durable lessons from the intermittent-login-rejection incident — where auth throttle state must live and how username identity must be normalized.
---

# Login lockout & identity

- **Cross-request auth state (throttles, lockouts) must live in the database, not process memory.** Why: an in-memory counter is wiped by restarts and is per-instance in production. The observed symptom was "login works after a redeploy / from another browser" — one stale client burned the failure budget and blocked the real user everywhere else. Update such counters with one atomic upsert; read-then-write loses counts under concurrency.
- **A normalized identity must use one expression on BOTH sides of every predicate** — lookup, throttle key, uniqueness constraint, duplicate pre-checks. Normalizing only the input strands stored values the constraint treats as equivalent (a completion review rejected exactly this gap).
- **Data-touching normalization must not share a transaction with schema a feature depends on.** A multi-statement boot query is one implicit transaction: if the data step fails on real-world duplicates, it rolls back the table the login path needs. Reconcile collisions deterministically (oldest keeps the name, newer renamed with its id, loudly logged), in a separately guarded step.
- **Production proxy strips client IPs** — login audit rows all show 127.0.0.1, so per-device forensics/throttling need trust-proxy work first (follow-up task exists).
- When exercising the limiter in dev, never burn failures against `admin` — use a disposable user.
- Auth-state tables belong on the company-reset table list, or a pre-reset lock outlives the reseed and blocks the fresh admin.
