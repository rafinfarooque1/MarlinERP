---
name: Salesman assignment
description: Rules for assigning salespeople to sales and keeping historical reporting stable.
---

Sales store both the selected employee reference and the employee name snapshot. New assignments require an active employee; Head Office employees can sell anywhere, while branch employees must match the sale location. An unchanged historical assignment remains editable after the employee becomes inactive or moves. Null assignments render as “Unassigned.”

**Why:** Reports and invoices must preserve who sold an older bill without making legacy documents impossible to edit when HR data changes.

**How to apply:** Reuse the same validation and grandfathering behavior in every sale producer, including desktop and employee-app flows.