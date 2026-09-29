# Frozen Fruits ERP — OpenAPI Operation Contracts

**Audit status:** STATIC SPEC INVENTORY — 110 OpenAPI operations; not a runtime contract verification.
**Snapshot date:** 2026-09-29
**Production database:** NOT QUERIED
**Tests/runtime probes:** NOT RUN

This file inventories parameters, request bodies, operation IDs, and declared success responses from `lib/api-spec/openapi.yaml`. Schema references resolve within that YAML. The 300 source-declared operations absent from OpenAPI are not represented here; see `ERP_API_INVENTORY.md`.

Audit basis: `lib/api-spec/openapi.yaml` has 66 path keys and exactly 110 HTTP operations. `ERP_API_INVENTORY.md` defines the canonical normalization (paths relative to `/api`, `{name}` -> `:name`) and reports 410 unique source operations, 110 matched, 300 absent, no spec-only operation. The normalized identities below are all 110; `—` means absent, `required=true/false` is requestBody requiredness, and `empty` means no response content. Every declared response content type is `application/json`; no binary response is declared.

### /accounts
|Method/path|operationId|path/query parameters|requestBody|success response(s)|
|---|---|---|---|---|
|`DELETE /accounts/cash-bank/:id`|`deleteCashBankAccount`|id=required|—|200 application/json: inline object `{success:boolean}`|
|`GET /accounts/cash-bank`|`listCashBankAccounts`|locationKeys=optional|—|200 application/json: array<$ref CashBankAccount>|
|`GET /accounts/chart`|`listChartOfAccounts`|—|—|200 application/json: array<$ref AccountLedger>|
|`GET /accounts/ledger-statement`|`getLedgerStatement`|accountId=required, fromDate=optional, toDate=optional|—|200 application/json: $ref LedgerStatement|
|`PATCH /accounts/cash-bank/:id`|`updateCashBankAccount`|id=required|required=true; application/json: $ref CashBankUpdate|200 application/json: $ref CashBankAccount|
|`PATCH /accounts/chart/:id`|`updateAccountLedger`|id=required|required=true; application/json: $ref AccountLedgerUpdate|200 application/json: $ref AccountLedger|
|`POST /accounts/cash-bank`|`createCashBankAccount`|—|required=true; application/json: $ref CashBankInput|201 application/json: $ref CashBankAccount|
|`POST /accounts/chart`|`createAccountLedger`|—|required=true; application/json: $ref AccountLedgerInput|201 application/json: $ref AccountLedger|

### /auth
|Method/path|operationId|path/query parameters|requestBody|success response(s)|
|---|---|---|---|---|
|`GET /auth/me`|`getMe`|—|—|200 application/json: $ref Employee|
|`POST /auth/change-password`|`changePassword`|—|required=true; application/json: $ref ChangePasswordInput|200 empty|
|`POST /auth/login`|`login`|—|required=true; application/json: $ref LoginInput|200 application/json: $ref AuthResponse; 401 empty|
|`POST /auth/logout`|`logout`|—|—|200 empty|

### /company
|Method/path|operationId|path/query parameters|requestBody|success response(s)|
|---|---|---|---|---|
|`GET /company/permissions`|`listPermissions`|—|—|200 application/json: array<$ref Permission>|
|`GET /company/settings`|`getCompanySettings`|—|—|200 application/json: $ref CompanySettings|
|`PATCH /company/settings`|`updateCompanySettings`|—|required=true; application/json: $ref CompanySettingsUpdate|200 application/json: $ref CompanySettings|
|`POST /company/permissions`|`setPermission`|—|required=true; application/json: $ref PermissionInput|200 application/json: $ref Permission|

### /coupons
|Method/path|operationId|path/query parameters|requestBody|success response(s)|
|---|---|---|---|---|
|`DELETE /coupons/:id`|`deleteCoupon`|id=required|—|204 empty|
|`GET /coupons`|`listCoupons`|—|—|200 application/json: array<$ref Coupon>|
|`PATCH /coupons/:id`|`updateCoupon`|id=required|required=true; application/json: $ref CouponUpdate|200 application/json: $ref Coupon|
|`POST /coupons`|`createCoupon`|—|required=true; application/json: $ref CouponInput|201 application/json: $ref Coupon|

### /customers
|Method/path|operationId|path/query parameters|requestBody|success response(s)|
|---|---|---|---|---|
|`GET /customers`|`listCustomers`|—|—|200 application/json: array<$ref Customer>|
|`GET /customers/:id`|`getCustomer`|id=required|—|200 application/json: $ref Customer|
|`PATCH /customers/:id`|`updateCustomer`|id=required|required=true; application/json: $ref CustomerUpdate|200 application/json: $ref Customer|
|`POST /customers`|`createCustomer`|—|required=true; application/json: $ref CustomerInput|201 application/json: $ref Customer|

### /dashboard
|Method/path|operationId|path/query parameters|requestBody|success response(s)|
|---|---|---|---|---|
|`GET /dashboard/recent-activity`|`getRecentActivity`|—|—|200 application/json: array<$ref ActivityItem>|
|`GET /dashboard/stock-alerts`|`getStockAlerts`|—|—|200 application/json: array<$ref StockAlert>|
|`GET /dashboard/summary`|`getDashboardSummary`|—|—|200 application/json: $ref DashboardSummary|

### /expenses
|Method/path|operationId|path/query parameters|requestBody|success response(s)|
|---|---|---|---|---|
|`GET /expenses`|`listExpenses`|—|—|200 application/json: array<$ref Expense>|
|`POST /expenses`|`createExpense`|—|required=true; application/json: $ref ExpenseInput|201 application/json: $ref Expense|

### /gst
|Method/path|operationId|path/query parameters|requestBody|success response(s)|
|---|---|---|---|---|
|`GET /gst/summary`|`getGstSummary`|fromDate=optional, toDate=optional|—|200 application/json: $ref GstSummary|

### /healthz
|Method/path|operationId|path/query parameters|requestBody|success response(s)|
|---|---|---|---|---|
|`GET /healthz`|`healthCheck`|—|—|200 application/json: $ref HealthStatus|

### /hr
|Method/path|operationId|path/query parameters|requestBody|success response(s)|
|---|---|---|---|---|
|`DELETE /hr/employees/:id`|`deleteEmployee`|id=required|—|204 empty|
|`DELETE /hr/hierarchies/:id`|`deleteHierarchy`|id=required|—|204 empty|
|`GET /hr/attendance`|`listAttendance`|employeeId=optional, date=optional|—|200 application/json: array<$ref AttendanceRecord>|
|`GET /hr/employees`|`listEmployees`|—|—|200 application/json: array<$ref Employee>|
|`GET /hr/employees/:id`|`getEmployee`|id=required|—|200 application/json: $ref Employee|
|`GET /hr/hierarchies`|`listHierarchies`|—|—|200 application/json: array<$ref Hierarchy>|
|`GET /hr/leaves`|`listLeaves`|employeeId=optional, status=optional, leaveType=optional, fromDate=optional, toDate=optional, branchType=optional, branchId=optional|—|200 application/json: array<$ref LeaveApplication>|
|`GET /hr/payroll`|`listPayroll`|month=optional, year=optional, branchId=optional|—|200 application/json: array<$ref PayrollRecord>|
|`PATCH /hr/employees/:id`|`updateEmployee`|id=required|required=true; application/json: $ref EmployeeUpdate|200 application/json: $ref Employee|
|`PATCH /hr/hierarchies/:id`|`updateHierarchy`|id=required|required=true; application/json: $ref HierarchyUpdate|200 application/json: $ref Hierarchy|
|`POST /hr/attendance/check-in`|`checkIn`|—|required=true; application/json: $ref AttendanceInput|201 application/json: $ref AttendanceRecord|
|`POST /hr/attendance/check-out`|`checkOut`|—|required=true; application/json: $ref AttendanceInput|200 application/json: $ref AttendanceRecord|
|`POST /hr/employees`|`createEmployee`|—|required=true; application/json: $ref EmployeeInput|201 application/json: $ref Employee|
|`POST /hr/hierarchies`|`createHierarchy`|—|required=true; application/json: $ref HierarchyInput|201 application/json: $ref Hierarchy|
|`POST /hr/leaves`|`applyLeave`|—|required=true; application/json: $ref LeaveInput|201 application/json: $ref LeaveApplication|
|`POST /hr/leaves/:id/approve`|`approveLeave`|id=required|required=true; application/json: $ref LeaveApprovalInput|200 application/json: $ref LeaveApplication|
|`POST /hr/leaves/:id/cancel`|`cancelLeave`|id=required|—|200 application/json: $ref LeaveApplication|
|`POST /hr/payroll/:id/pay`|`markPayrollPaid`|id=required|—|200 application/json: $ref PayrollRecord|
|`PUT /hr/attendance`|`correctAttendance`|—|required=true; application/json: $ref AttendanceCorrection|200 application/json: $ref AttendanceRecord|
|`PUT /hr/attendance/bulk`|`bulkCorrectAttendance`|—|required=true; application/json: $ref BulkAttendanceCorrection|200 application/json: $ref BulkAttendanceCorrectionResult|

### /item-prices
|Method/path|operationId|path/query parameters|requestBody|success response(s)|
|---|---|---|---|---|
|`GET /item-prices`|`listItemPrices`|outletId=optional|—|200 application/json: array<$ref ItemPrice>|
|`POST /item-prices`|`setItemPrice`|—|required=true; application/json: $ref ItemPriceInput|200 application/json: $ref ItemPrice|

### /items
|Method/path|operationId|path/query parameters|requestBody|success response(s)|
|---|---|---|---|---|
|`DELETE /items/:id`|`deleteItem`|id=required|—|204 empty|
|`GET /items`|`listItems`|—|—|200 application/json: array<$ref Item>|
|`GET /items/:id`|`getItem`|id=required|—|200 application/json: $ref Item|
|`PATCH /items/:id`|`updateItem`|id=required|required=true; application/json: $ref ItemUpdate|200 application/json: $ref Item|
|`POST /items`|`createItem`|—|required=true; application/json: $ref ItemInput|201 application/json: $ref Item|

### /materials
|Method/path|operationId|path/query parameters|requestBody|success response(s)|
|---|---|---|---|---|
|`DELETE /materials/:id`|`deleteMaterial`|id=required|—|204 empty|
|`GET /materials`|`listMaterials`|—|—|200 application/json: array<$ref Material>|
|`GET /materials/:id`|`getMaterial`|id=required|—|200 application/json: $ref Material|
|`PATCH /materials/:id`|`updateMaterial`|id=required|required=true; application/json: $ref MaterialUpdate|200 application/json: $ref Material|
|`POST /materials`|`createMaterial`|—|required=true; application/json: $ref MaterialInput|201 application/json: $ref Material|

### /outlets
|Method/path|operationId|path/query parameters|requestBody|success response(s)|
|---|---|---|---|---|
|`DELETE /outlets/:id`|`deleteOutlet`|id=required|—|204 empty|
|`GET /outlets`|`listOutlets`|—|—|200 application/json: array<$ref Outlet>|
|`GET /outlets/:id`|`getOutlet`|id=required|—|200 application/json: $ref Outlet|
|`PATCH /outlets/:id`|`updateOutlet`|id=required|required=true; application/json: $ref OutletUpdate|200 application/json: $ref Outlet|
|`POST /outlets`|`createOutlet`|—|required=true; application/json: $ref OutletInput|201 application/json: $ref Outlet|

### /productions
|Method/path|operationId|path/query parameters|requestBody|success response(s)|
|---|---|---|---|---|
|`GET /productions`|`listProductions`|—|—|200 application/json: array<$ref Production>|
|`GET /productions/:id`|`getProduction`|id=required|—|200 application/json: $ref Production|
|`POST /productions`|`createProduction`|—|required=true; application/json: $ref ProductionInput|201 application/json: $ref Production|

### /public
|Method/path|operationId|path/query parameters|requestBody|success response(s)|
|---|---|---|---|---|
|`GET /public/app/info`|`getPublicAppInfo`|—|—|200 application/json: $ref PublicAppInfo|

### /purchases
|Method/path|operationId|path/query parameters|requestBody|success response(s)|
|---|---|---|---|---|
|`GET /purchases`|`listPurchases`|—|—|200 application/json: array<$ref Purchase>|
|`GET /purchases/:id`|`getPurchase`|id=required|—|200 application/json: $ref Purchase|
|`POST /purchases`|`createPurchase`|—|required=true; application/json: $ref PurchaseInput|201 application/json: $ref Purchase|

### /quotation-payment-terms
|Method/path|operationId|path/query parameters|requestBody|success response(s)|
|---|---|---|---|---|
|`DELETE /quotation-payment-terms/:id`|`deleteQuotationPaymentTerm`|id=required|—|200 application/json: inline object `{success:boolean}`|
|`GET /quotation-payment-terms`|`listQuotationPaymentTerms`|—|—|200 application/json: array<$ref QuotationPaymentTerm>|
|`PATCH /quotation-payment-terms/:id`|`updateQuotationPaymentTerm`|id=required|required=true; application/json: $ref QuotationPaymentTermInput|200 application/json: $ref QuotationPaymentTerm|
|`POST /quotation-payment-terms`|`createQuotationPaymentTerm`|—|required=true; application/json: $ref QuotationPaymentTermInput|201 application/json: $ref QuotationPaymentTerm|

### /quotations
|Method/path|operationId|path/query parameters|requestBody|success response(s)|
|---|---|---|---|---|
|`DELETE /quotations/:id`|`deleteQuotation`|id=required|—|200 application/json: inline object `{success:boolean}`|
|`GET /quotations`|`listQuotations`|q=optional, from=optional, to=optional, status=optional, locationType=optional, locationId=optional, customerId=optional, salesperson=optional|—|200 application/json: array<$ref Quotation>|
|`GET /quotations/:id`|`getQuotation`|id=required|—|200 application/json: $ref Quotation|
|`GET /quotations/salespeople`|`listQuotationSalespeople`|—|—|200 application/json: array<$ref QuotationSalesperson>|
|`POST /quotations`|`createQuotation`|—|required=true; application/json: $ref QuotationInput|201 application/json: $ref Quotation|
|`POST /quotations/:id/status`|`setQuotationStatus`|id=required|required=true; application/json: $ref QuotationStatusInput|200 application/json: $ref Quotation|
|`PUT /quotations/:id`|`updateQuotation`|id=required|required=true; application/json: $ref QuotationInput|200 application/json: $ref Quotation|

### /raw-materials
|Method/path|operationId|path/query parameters|requestBody|success response(s)|
|---|---|---|---|---|
|`DELETE /raw-materials/:id`|`deleteRawMaterial`|id=required|—|204 empty|
|`GET /raw-materials`|`listRawMaterials`|—|—|200 application/json: array<$ref RawMaterial>|
|`GET /raw-materials/:id`|`getRawMaterial`|id=required|—|200 application/json: $ref RawMaterial|
|`PATCH /raw-materials/:id`|`updateRawMaterial`|id=required|required=true; application/json: $ref RawMaterialUpdate|200 application/json: $ref RawMaterial|
|`POST /raw-materials`|`createRawMaterial`|—|required=true; application/json: $ref RawMaterialInput|201 application/json: $ref RawMaterial|

### /reconciliation
|Method/path|operationId|path/query parameters|requestBody|success response(s)|
|---|---|---|---|---|
|`GET /reconciliation/pending-queue`|`listReconciliationPendingQueue`|locationType=optional, locationId=optional, method=optional, platformLedgerId=optional, fromDate=optional, toDate=optional, search=optional|—|200 application/json: array<$ref ReconciliationPendingQueueItem>|
|`POST /reconciliation/settle-queue`|`settleReconciliationPendingQueue`|—|required=true; application/json: $ref ReconciliationQueueSettlementRequest|201 application/json: $ref ReconciliationQueueSettlementResult|

### /sales
|Method/path|operationId|path/query parameters|requestBody|success response(s)|
|---|---|---|---|---|
|`GET /sales`|`listSales`|outletId=optional|—|200 application/json: array<$ref Sale>|
|`GET /sales/:id`|`getSale`|id=required|—|200 application/json: $ref Sale|
|`GET /sales/summary`|`getSalesSummary`|—|—|200 application/json: $ref SalesSummary|
|`POST /sales`|`createSale`|—|required=true; application/json: $ref SaleInput|201 application/json: $ref Sale|

### /stock
|Method/path|operationId|path/query parameters|requestBody|success response(s)|
|---|---|---|---|---|
|`GET /stock`|`listStock`|branchId=optional, branchType=optional|—|200 application/json: array<$ref StockEntry>|
|`GET /stock/transfers`|`listStockTransfers`|—|—|200 application/json: array<$ref StockTransfer>|
|`GET /stock/transfers/:id`|`getStockTransfer`|id=required|—|200 application/json: $ref StockTransfer|
|`POST /stock/transfers`|`createStockTransfer`|—|required=true; application/json: $ref StockTransferInput|201 application/json: $ref StockTransfer|

### /vendors
|Method/path|operationId|path/query parameters|requestBody|success response(s)|
|---|---|---|---|---|
|`GET /vendors`|`listVendors`|—|—|200 application/json: array<$ref Vendor>|
|`GET /vendors/:id`|`getVendor`|id=required|—|200 application/json: $ref Vendor|
|`PATCH /vendors/:id`|`updateVendor`|id=required|required=true; application/json: $ref VendorUpdate|200 application/json: $ref Vendor|
|`POST /vendors`|`createVendor`|—|required=true; application/json: $ref VendorInput|201 application/json: $ref Vendor|

### /warehouses
|Method/path|operationId|path/query parameters|requestBody|success response(s)|
|---|---|---|---|---|
|`DELETE /warehouses/:id`|`deleteWarehouse`|id=required|—|204 empty|
|`GET /warehouses`|`listWarehouses`|—|—|200 application/json: array<$ref Warehouse>|
|`GET /warehouses/:id`|`getWarehouse`|id=required|—|200 application/json: $ref Warehouse|
|`PATCH /warehouses/:id`|`updateWarehouse`|id=required|required=true; application/json: $ref WarehouseUpdate|200 application/json: $ref Warehouse|
|`POST /warehouses`|`createWarehouse`|—|required=true; application/json: $ref WarehouseInput|201 application/json: $ref Warehouse|

### Verification and unresolved refs
- Count of rows: **110**; count of OpenAPI operations: **110**; path keys: **66**.
- Normalized identities use `:id` for OpenAPI `{id}` and otherwise preserve literal path segments. They match the canonical route manifest identities described in `ERP_API_INVENTORY.md`; the inventory explicitly records **110/110 matched**, **300 source-only**, and **0 spec-only** operations.
- Ref audit: all `$ref` values used by operation request/response schemas resolve to a named `#/components/schemas/*` entry in this YAML. **No unresolved or ambiguous schema refs.**
- Inline operation schemas: only the three delete-success shapes above are inline (`object` with `success:boolean`); all other operation schemas are named refs or arrays whose items are named refs. No binary content type is present. Empty responses are explicitly marked above.
