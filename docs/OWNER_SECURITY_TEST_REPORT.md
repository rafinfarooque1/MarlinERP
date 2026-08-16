# Security & Cross-Role Test Report — August 16, 2026

This report explains, in plain language, what was actually tested across the
ERP and the employee mobile app, what was found, what was fixed, and — just as
important — what was **not** tested and why. It was produced as the final step
of the cross-role security review (Task #338). Every claim below maps to a test
that was executed in this round; anything that could not be executed is listed
under "Not verified" with the reason.

## How the tests were run

- Two automated test suites drive the live system through its own API, exactly
  the way the apps do (they live in `artifacts/api-server/tests/` and can be
  re-run any time):
  - `mobile-rbac-lbac.test.mjs` — the role and location-security matrix.
    **114 checks, all passing.**
  - `employee-regression-338.test.mjs` — the employee self-service flows.
    **24 checks, all passing.**
- A real browser (mobile-sized) drove the employee app for the screens and
  double-tap tests, with screenshots taken as evidence.
- Test users were created **through the app's own employee-management screens'
  API**, not by editing the database — so the tests prove the same path a real
  manager uses. One bootstrap admin per suite is the only direct database
  insert (the tests must never touch the real admin account's password), and it
  is removed at the end.

## 1. Role matrix — who can see and do what

Five roles were exercised: **administrator**, **Management (view-only, head
office)**, **warehouse manager (Ragiguda)**, **sales officer (Ragiguda)** and
**warehouse manager (Calicut)**. Each was created through the app, logged in
with the standard starter password, was **forced to change it** (and the old
password verified dead), and was then pointed at every major data surface:
sales, dispatch, stock, dashboard, payroll, attendance, leaves, **and the
voucher books (receipts, payments, journal vouchers)**.

- Every screen's data answered only for the roles whose permission settings
  allow it — the expectations are read from your live permission matrix at
  test time, so the tests follow whatever you configure, not a stale copy.
- Refusals are honest: "not allowed" (403) is distinct from "bad input" (400)
  and "doesn't exist" (404), so the apps can react correctly.
- Non-admin users receive only their own role's permission rows — no role can
  read another role's rights.

**The sixth role — outlet employee — could not be tested and is marked NOT
VERIFIED below.** Your business has the Outlet module switched off and zero
outlets. The tests instead prove the door is properly shut: creating an outlet
and hiring an outlet employee were both attempted and both correctly refused
with the "outlets disabled" answer.

## 2. Location walls — one branch cannot see the other

Every branch user tried to reach the *other* branch's data every way we could
think of: spoofing the location headers the app sends, changing query
parameters by hand, guessing record numbers directly, posting a payment into
the other branch's bill, marking the other branch's order dispatched, creating
a sale in the other branch's name, **listing the other branch's money
vouchers, and recording a receipt into the other branch's cash till**. Every
attempt was refused, and the database was checked after each one to prove
nothing was written and nothing leaked.

- **One genuine leak was found and closed in this round.** When a branch user
  probed a foreign bill with a payment, the refusal message could reveal that
  bill's outstanding balance — a Ragiguda manager could learn what a Calicut
  customer owed by probing bill numbers. The order of checks was corrected so
  the location wall always comes first; the same probe now gives away nothing.
  Re-tested and confirmed, including the retry path.

## 3. Employee self-service — the daily flows

Verified end-to-end at the API (24 automated checks) and in the browser:

- **Login / forced password change / logout behaviour** — first login with the
  starter password demands a change; the old password stops working
  immediately.
- **Profile** — opened in the app (screenshot evidence): shows the employee's
  name, role and branch; the API never exposes password data.
- **Attendance check-in / check-out** — checking in opens the day, checking in
  *twice* is refused (the double-tap guard), checking in **for somebody else**
  is refused, checking out closes the day and the day appears in the
  employee's own calendar.
- **Leave apply / cancel** — an employee can raise a leave request and cancel
  it while it is pending; the cancelled request stays visible as "cancelled"
  (that is by design — an audit trail), and cancelling twice is refused.
- **Payslips screen** — opens correctly (verified in the earlier browser
  round). Downloading a payslip **PDF** could not be exercised — see "Not
  verified".

## 4. Double-tap and flaky-network protection

- **New Sale (mobile):** a real browser built a walk-in cash sale and
  double-clicked the save button. Exactly **one** bill was created (verified
  by counting rows in the database before and after). The server-side
  double-submit protection on sales was separately re-verified by its own
  suite (29 automated checks, all passing).
- **Receipt voucher (mobile):** same double-click test on the voucher save
  button — exactly **one** voucher was created. (Voucher protection is in the
  app itself; worth knowing, but it held under test.)
- **Offline:** with the network cut, the app showed its red **"No Internet
  Connection"** banner (screenshot evidence). After reconnecting, the record
  count was re-checked — nothing double-fired.

## 5. A bonus find — employee deletion was broken

Testing through the app's own paths surfaced a real bug unrelated to security:
**deleting any employee created through the app failed with a server error**,
because the pay-structure record the app itself creates was blocking the
deletion. This is now fixed: deleting an employee removes their pay structure
with them, and if the employee has real history (attendance, payroll, leaves,
advances) the app now refuses with a clear message telling you to mark them
inactive instead — history is never silently destroyed.

## Nothing left behind

- All temporary users were deleted **through the app's own delete path** (the
  bootstrap admins and login-audit rows via cleanup, as documented in the
  suites).
- The one test sale was cancelled and the two ₹1/₹720 test collections removed
  through the app's own admin paths.
- The trial balance was verified identical before and after every round
  (₹24,85,972.62 both sides at the final check), and row counts for sales,
  payments, receipts, stock, attendance and leaves were verified restored.
- A final sweep confirmed **zero** test users remain.

## 6. Follow-up round — Day Book rights and the app-download screen

Two items from the original acceptance list were still open after the main
round. Both were tested on 16 August 2026 with the same method (temporary
users created through the app's own employee screen, removed afterwards):

- **Day Book permission — PASS at both layers.** A warehouse employee whose
  role has Day Book switched **on** sees it in the menu, opens it, and gets
  exactly their own warehouse's figures for the day. Attempts to trick the
  system into showing another warehouse or the whole company — by editing the
  web address, the location headers and the request parameters, all at once —
  returned the identical own-warehouse figures every time. A warehouse
  employee whose role has Day Book switched **off** does not see the menu
  entry, and typing the address directly shows "Access Denied" with no data;
  the server also refuses the raw request (403). Company-level totals are
  never included in a branch employee's day book.
- **Download Mobile App — PASS, honest by design.** The menu entry opens the
  dialog correctly. Because no App Store / Google Play links are configured
  in Settings → Mobile App (the app is not on the stores yet), the dialog
  says exactly that — "hasn't been published yet" — with the store buttons
  shown as "Coming soon" and **no QR code and no fake store links**. The
  public link the QR would carry was also tested from the server side with
  iPhone, Android and desktop identities: with nothing configured it shows an
  honest "not published yet" page rather than pretending a listing exists.
  Once real store links are saved in Settings, the same dialog and link will
  redirect each device to the right store automatically.

After this round the books were re-checked: trial balance still agrees to the
paisa (₹24,85,972.62 both sides) and no temporary users remain.

One small blemish spotted along the way (not a security issue): after
pressing Log Out on the website, the screen can sit on a loading state
instead of returning straight to the login page. Noted as a follow-up task.

## Not verified — and why

Being explicit about what was *not* proven:

- **Outlet employee role.** The Outlet module is switched off in your settings
  and the business has no outlets. Testing it would have meant changing your
  live settings and creating outlet ledgers in your real books. What *was*
  proven: outlet creation and outlet staffing are both correctly refused while
  the module is off. If you ever enable outlets, this role should be tested
  then.
- **Payslip PDF download.** A payslip PDF needs a real payroll record, and
  generating payroll for a temporary employee would have written into your
  real books. The payslips screen itself was verified; the PDF button was not.
- **iPhone on a real device.** The earlier iPhone tab fix is code-verified and
  browser-verified, but only a real device proves the iPhone experience —
  **please check Payslips / Attendance / Leaves and the Dispatch View button
  on your phone.**
- **Known design limitation (unchanged):** a sales officer's role cannot read
  payroll data — by design; noted here so it isn't mistaken for a bug.

## Honest status notes

- **App stores:** the employee app runs via Expo (preview/web). It has not
  been submitted to the Apple App Store or Google Play; that is a separate
  process with its own accounts, review times and fees, and can be planned
  when you are ready.
- **Publishing:** the fixes in this round (the balance-leak fix, the employee
  deletion fix) live in the development workspace. They reach the live
  (published) system only when the project is published again.
