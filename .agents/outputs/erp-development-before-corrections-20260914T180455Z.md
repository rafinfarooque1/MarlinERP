# ERP accounting correction baseline

Captured before correction implementation on 2026-09-14.

## Recovery point

- Development database dump: `.agents/outputs/erp-development-before-corrections-20260914T180455Z.dump`
- SHA-256: `0c6c67009d8c7b860d864579f6750b40701385fd8ceb6d60b06dd6a158e7b1f5`
- Repository commit: `b8ab4b71721986d885cef6f6e8b71ede819b8193`
- Production was not modified.

## Before-state accounting totals

| Area | Before state |
| --- | ---: |
| Stored journal vouchers | 212 |
| Stored journal lines | 478 |
| Journal debits | ₹4,520,755.31 |
| Journal credits | ₹4,520,755.31 |
| Journal difference | ₹0.00 |
| Opening-balance debits | ₹5,998.00 |
| Opening-balance credits | ₹5,998.00 |
| Current stock quantity | 54,963.398 |
| Current weighted-average inventory value | ₹11,279,381.916 |
| Batch inventory value | ₹11,270,928.912 |
| Batch/current value difference | ₹8,453.004 |
| Raw receivables | ₹905,472.78 |
| Clamped outstanding receivables | ₹917,568.10 |
| Customer credit/overpayment balance | ₹12,095.32 |
| Bank reconciliation entries | 26 |
| Reconciled bank entries | 0 |
| Bank reconciliation batches | 0 |
| Fixed-asset purchases | 12 |
| Fixed-asset acquisition value | ₹375,945.62 |

## Known review items

- Historical COGS can be negative because historical closing stock is reconstructed using today's weighted-average cost.
- Historical inventory movement completeness is not guaranteed for stock that predates the append-only movement log.
- Vendor bill allocations exceed two bills by ₹1,890 total:
  - Invoice 5052: ₹1,260 excess
  - Invoice 5408: ₹630 excess
- Fixed-asset depreciation is not posted.
- Audit logging is asynchronous and failures are swallowed.
- Bank reconciliation has no reconciled entries or batches in the audited development state.

This file records the observed state only. It is not an instruction to force any report to balance or to delete history.