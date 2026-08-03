---
name: Multi-punch attendance
description: Punch-session layer over the attendance table — pricing rule, correction contract, day-boundary timezone, geolocation UI trap.
---

# Multi-punch attendance

- `attendance_punches` is a raw startup-migration table (invisible to drizzle — raw SQL only). The `attendance` row keeps first-in/last-out + status; punches are the session detail.
- **Pricing rule:** a day WITH punch rows is paid on the SUM of its closed sessions; a day WITHOUT punch rows prices on the first-in→last-out span exactly as before. `dayContribution` (successor of `dayFactor`, returns {work, leave}) takes optional `punchedHours`; every attendance reader that feeds it (payroll generate, approval staleness check, daily accrual) must LEFT JOIN `PUNCHED_HOURS_JOIN` or the three consumers disagree about what a day is worth.
  **Why:** the span counts breaks between sessions as work; legacy rows must stay worth exactly what they always were.
- **Correction contract:** PUT with explicit checkIn/checkOut REPLACES the day's punches with one pair (null clears all); status-only PUT leaves punches alone (hours outvote the label). The web correction dialog therefore always sends `checkIn:null, checkOut:null` so a status correction actually reprices — and says so in its warning text.
- **One open session:** second check-in while open = 409; check-out with nothing open = 409. Re-check-in after check-out reopens the day (attendance.check_out → NULL, day provisionally whole). A legacy day being reopened first backfills its old span as a closed punch or those hours would vanish from the total.
- **Day boundary is the company timezone**, not UTC: check-in/check-out/register-default use `businessTodayStr()` (Asia/Kolkata default from company settings). At 00:30 IST the UTC date is still yesterday. Web uses the device-local date (`toLocaleDateString('en-CA')`), never `toISOString()`. RESIDUE: payroll approve/pay and advances voucher dates still use UTC today.
- Derived register fields (punches[], workingHours, lateMinutes, overtimeHours, openPunchIn) are computed server-side; overtime is withheld (null) while a session is open. Late/OT settings (dayStartTime, grace, standardWorkHours) are display-only — they play no part in pay.
