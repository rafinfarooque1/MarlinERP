CREATE TABLE "company_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_name" text DEFAULT 'Marlin Frozen Fruits' NOT NULL,
	"address" text,
	"city" text,
	"state" text,
	"pincode" text,
	"phone" text,
	"email" text,
	"website" text,
	"gst_number" text,
	"pan_number" text,
	"bank_name" text,
	"bank_account" text,
	"ifsc_code" text,
	"logo_url" text,
	"currency" text DEFAULT 'INR' NOT NULL,
	"financial_year" text DEFAULT '2025-26' NOT NULL,
	"invoice_prefix" text DEFAULT 'INV' NOT NULL,
	"invoice_sequence" integer DEFAULT 0 NOT NULL,
	"fy_start_month" integer DEFAULT 4 NOT NULL,
	"voucher_prefixes" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outlets" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"warehouse_id" integer NOT NULL,
	"address" text,
	"contact_person" text,
	"phone" text,
	"upi_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "warehouses" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"state" text NOT NULL,
	"gst_number" text NOT NULL,
	"address" text,
	"contact_person" text,
	"phone" text,
	"upi_id" text,
	"billing_name" text,
	"email" text,
	"city" text,
	"district" text,
	"pincode" text,
	"state_code" text,
	"fssai_number" text,
	"bank_account_holder" text,
	"bank_name" text,
	"bank_branch" text,
	"bank_account_number" text,
	"ifsc_code" text,
	"invoice_footer" text,
	"authorized_signatory" text,
	"logo_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vendors" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"phone" text,
	"email" text,
	"address" text,
	"gst_number" text,
	"state" text,
	"bank_name" text,
	"account_number" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"phone" text,
	"email" text,
	"address" text,
	"gst_number" text,
	"state" text,
	"total_purchases" numeric(12, 2) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "item_prices" (
	"id" serial PRIMARY KEY NOT NULL,
	"item_id" integer NOT NULL,
	"outlet_id" integer NOT NULL,
	"price" numeric(10, 2) DEFAULT '0' NOT NULL,
	"valid_from" text,
	"valid_to" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "items" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"hsn_code" text NOT NULL,
	"tax_rate" numeric(5, 2) DEFAULT '0' NOT NULL,
	"unit" text NOT NULL,
	"description" text,
	"production_stock" numeric(10, 3) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "items_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "materials" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"unit" text NOT NULL,
	"description" text,
	"current_stock" numeric(10, 3) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "materials_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "raw_materials" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"unit" text NOT NULL,
	"description" text,
	"current_stock" numeric(10, 3) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "raw_materials_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "stock_batches" (
	"id" serial PRIMARY KEY NOT NULL,
	"item_id" integer NOT NULL,
	"branch_type" text NOT NULL,
	"branch_id" integer NOT NULL,
	"batch_number" text NOT NULL,
	"mfg_date" date,
	"expiry_date" date,
	"quantity" numeric(12, 3) DEFAULT '0' NOT NULL,
	"unit_cost" numeric(12, 2) DEFAULT '0' NOT NULL,
	"source" text,
	"source_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"item_id" integer NOT NULL,
	"branch_type" text NOT NULL,
	"branch_id" integer NOT NULL,
	"quantity" numeric(10, 3) DEFAULT '0' NOT NULL,
	"cost_price" numeric(10, 2) DEFAULT '0' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_verifications" (
	"id" serial PRIMARY KEY NOT NULL,
	"branch_type" text NOT NULL,
	"branch_id" integer NOT NULL,
	"verify_date" date NOT NULL,
	"notes" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchases" (
	"id" serial PRIMARY KEY NOT NULL,
	"vendor_id" integer NOT NULL,
	"purchase_date" date NOT NULL,
	"invoice_number" text,
	"line_items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"total_amount" numeric(12, 2) DEFAULT '0' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bom_templates" (
	"id" serial PRIMARY KEY NOT NULL,
	"item_id" integer NOT NULL,
	"lines" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bom_templates_item_id_unique" UNIQUE("item_id")
);
--> statement-breakpoint
CREATE TABLE "productions" (
	"id" serial PRIMARY KEY NOT NULL,
	"item_id" integer NOT NULL,
	"produced_quantity" numeric(10, 3) NOT NULL,
	"production_date" date NOT NULL,
	"material_used" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_transfers" (
	"id" serial PRIMARY KEY NOT NULL,
	"challan_number" text NOT NULL,
	"from_type" text NOT NULL,
	"from_id" integer NOT NULL,
	"to_type" text NOT NULL,
	"to_id" integer NOT NULL,
	"transfer_date" date NOT NULL,
	"line_items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_interstate" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'in_transit' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales" (
	"id" serial PRIMARY KEY NOT NULL,
	"invoice_number" text NOT NULL,
	"outlet_id" integer,
	"customer_id" integer,
	"sale_date" date NOT NULL,
	"line_items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"subtotal" numeric(12, 2) DEFAULT '0' NOT NULL,
	"tax_total" numeric(12, 2) DEFAULT '0' NOT NULL,
	"discount_total" numeric(12, 2) DEFAULT '0' NOT NULL,
	"bill_discount" numeric(12, 2) DEFAULT '0' NOT NULL,
	"total_amount" numeric(12, 2) DEFAULT '0' NOT NULL,
	"payment_mode" text NOT NULL,
	"coupon_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoice_share_links" (
	"id" serial PRIMARY KEY NOT NULL,
	"public_id" text NOT NULL,
	"sale_id" integer NOT NULL,
	"token" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"access_count" integer DEFAULT 0 NOT NULL,
	"last_access_at" timestamp with time zone,
	"revoked_by" integer,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "attendance" (
	"id" serial PRIMARY KEY NOT NULL,
	"employee_id" integer NOT NULL,
	"date" date NOT NULL,
	"check_in" timestamp with time zone,
	"check_out" timestamp with time zone,
	"check_in_lat" numeric(10, 7),
	"check_in_lng" numeric(10, 7),
	"check_out_lat" numeric(10, 7),
	"check_out_lng" numeric(10, 7),
	"status" text DEFAULT 'present' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employees" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"username" text NOT NULL,
	"password_hash" text DEFAULT 'default123' NOT NULL,
	"email" text,
	"phone" text,
	"hierarchy_id" integer NOT NULL,
	"branch_type" text NOT NULL,
	"branch_id" integer NOT NULL,
	"salary" numeric(10, 2) DEFAULT '0' NOT NULL,
	"join_date" date NOT NULL,
	"photo_url" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"must_change_password" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employees_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE "hierarchies" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"level" integer NOT NULL,
	"reports_to_id" integer,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leaves" (
	"id" serial PRIMARY KEY NOT NULL,
	"employee_id" integer NOT NULL,
	"from_date" date NOT NULL,
	"to_date" date NOT NULL,
	"leave_type" text NOT NULL,
	"reason" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"approved_by" integer,
	"approval_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pay_components" (
	"id" serial PRIMARY KEY NOT NULL,
	"employee_id" integer NOT NULL,
	"working_days_per_month" integer DEFAULT 26 NOT NULL,
	"allowances" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"deductions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pay_components_employee_id_unique" UNIQUE("employee_id")
);
--> statement-breakpoint
CREATE TABLE "payroll" (
	"id" serial PRIMARY KEY NOT NULL,
	"employee_id" integer NOT NULL,
	"month" integer NOT NULL,
	"year" integer NOT NULL,
	"base_salary" numeric(10, 2) DEFAULT '0' NOT NULL,
	"working_days" integer DEFAULT 26 NOT NULL,
	"present_days" integer DEFAULT 26 NOT NULL,
	"lop_days" integer DEFAULT 0 NOT NULL,
	"lop_deduction" numeric(10, 2) DEFAULT '0' NOT NULL,
	"gross_pay" numeric(10, 2) DEFAULT '0' NOT NULL,
	"allowances_total" numeric(10, 2) DEFAULT '0' NOT NULL,
	"allowances_breakdown" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"deductions" numeric(10, 2) DEFAULT '0' NOT NULL,
	"deductions_breakdown" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"net_pay" numeric(10, 2) DEFAULT '0' NOT NULL,
	"bonus" numeric(10, 2) DEFAULT '0' NOT NULL,
	"total_amount" numeric(10, 2) DEFAULT '0' NOT NULL,
	"notes" text,
	"is_paid" boolean DEFAULT false NOT NULL,
	"paid_date" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account_ledgers" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"parent_id" integer,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cash_bank_accounts" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"account_type" text NOT NULL,
	"bank_name" text,
	"account_number" text,
	"ifsc_code" text,
	"balance" numeric(12, 2) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "expenses" (
	"id" serial PRIMARY KEY NOT NULL,
	"ledger_account_id" integer NOT NULL,
	"payment_account_id" integer NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"expense_date" date NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coupons" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"discount_type" text NOT NULL,
	"discount_value" numeric(10, 2) NOT NULL,
	"valid_days" integer NOT NULL,
	"expiry_date" date,
	"is_active" boolean DEFAULT true NOT NULL,
	"usage_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coupons_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "permissions" (
	"id" serial PRIMARY KEY NOT NULL,
	"hierarchy_id" integer NOT NULL,
	"module" text NOT NULL,
	"can_view" boolean DEFAULT false NOT NULL,
	"can_add" boolean DEFAULT false NOT NULL,
	"can_edit" boolean DEFAULT false NOT NULL,
	"can_delete" boolean DEFAULT false NOT NULL,
	"can_download" boolean DEFAULT false NOT NULL,
	"can_print" boolean DEFAULT false NOT NULL,
	"can_approve" boolean DEFAULT false NOT NULL,
	"can_share" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "activity_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"type" text DEFAULT '' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"user" text DEFAULT 'system' NOT NULL,
	"action" text DEFAULT 'CREATE' NOT NULL,
	"module" text DEFAULT '' NOT NULL,
	"entity_type" text DEFAULT '' NOT NULL,
	"entity_id" integer,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "outlets" ADD CONSTRAINT "outlets_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_prices" ADD CONSTRAINT "item_prices_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bom_templates" ADD CONSTRAINT "bom_templates_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "productions" ADD CONSTRAINT "productions_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_share_links" ADD CONSTRAINT "invoice_share_links_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_share_links" ADD CONSTRAINT "invoice_share_links_created_by_employees_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_share_links" ADD CONSTRAINT "invoice_share_links_revoked_by_employees_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance" ADD CONSTRAINT "attendance_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_hierarchy_id_hierarchies_id_fk" FOREIGN KEY ("hierarchy_id") REFERENCES "public"."hierarchies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leaves" ADD CONSTRAINT "leaves_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_components" ADD CONSTRAINT "pay_components_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll" ADD CONSTRAINT "payroll_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_ledger_account_id_account_ledgers_id_fk" FOREIGN KEY ("ledger_account_id") REFERENCES "public"."account_ledgers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_payment_account_id_cash_bank_accounts_id_fk" FOREIGN KEY ("payment_account_id") REFERENCES "public"."cash_bank_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permissions" ADD CONSTRAINT "permissions_hierarchy_id_hierarchies_id_fk" FOREIGN KEY ("hierarchy_id") REFERENCES "public"."hierarchies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_share_links_public_id_uq" ON "invoice_share_links" USING btree ("public_id");--> statement-breakpoint
CREATE UNIQUE INDEX "permissions_hierarchy_module_uq" ON "permissions" USING btree ("hierarchy_id","module");