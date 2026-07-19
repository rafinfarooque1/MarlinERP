import { pgTable, text, serial, timestamp, numeric, integer, boolean, date, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const hierarchiesTable = pgTable("hierarchies", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  level: integer("level").notNull(),
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const employeesTable = pgTable("employees", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull().default("default123"),
  email: text("email"),
  phone: text("phone"),
  hierarchyId: integer("hierarchy_id").notNull().references(() => hierarchiesTable.id),
  branchType: text("branch_type").notNull(), // production, headoffice, warehouse, outlet
  branchId: integer("branch_id").notNull(),
  salary: numeric("salary", { precision: 10, scale: 2 }).notNull().default("0"),
  joinDate: date("join_date", { mode: "string" }).notNull(),
  photoUrl: text("photo_url"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const payrollTable = pgTable("payroll", {
  id: serial("id").primaryKey(),
  employeeId: integer("employee_id").notNull().references(() => employeesTable.id),
  month: integer("month").notNull(),
  year: integer("year").notNull(),
  baseSalary: numeric("base_salary", { precision: 10, scale: 2 }).notNull().default("0"),
  // Extended payroll fields
  workingDays: integer("working_days").notNull().default(26),
  presentDays: integer("present_days").notNull().default(26),
  lopDays: integer("lop_days").notNull().default(0),
  lopDeduction: numeric("lop_deduction", { precision: 10, scale: 2 }).notNull().default("0"),
  grossPay: numeric("gross_pay", { precision: 10, scale: 2 }).notNull().default("0"),
  allowancesTotal: numeric("allowances_total", { precision: 10, scale: 2 }).notNull().default("0"),
  allowancesBreakdown: jsonb("allowances_breakdown").notNull().default([]),
  deductions: numeric("deductions", { precision: 10, scale: 2 }).notNull().default("0"),
  deductionsBreakdown: jsonb("deductions_breakdown").notNull().default([]),
  netPay: numeric("net_pay", { precision: 10, scale: 2 }).notNull().default("0"),
  // Legacy / bonuses
  bonus: numeric("bonus", { precision: 10, scale: 2 }).notNull().default("0"),
  totalAmount: numeric("total_amount", { precision: 10, scale: 2 }).notNull().default("0"),
  notes: text("notes"),
  isPaid: boolean("is_paid").notNull().default(false),
  paidDate: date("paid_date", { mode: "string" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Pay structure per employee (allowances + deduction config)
export const payComponentsTable = pgTable("pay_components", {
  id: serial("id").primaryKey(),
  employeeId: integer("employee_id").notNull().unique().references(() => employeesTable.id),
  workingDaysPerMonth: integer("working_days_per_month").notNull().default(26),
  // allowances: [{name, type: 'fixed'|'percent_of_basic', value}]
  allowances: jsonb("allowances").notNull().default([]),
  // deductions: [{name, type: 'fixed'|'percent_of_basic'|'percent_of_gross', value, enabled}]
  deductions: jsonb("deductions").notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const attendanceTable = pgTable("attendance", {
  id: serial("id").primaryKey(),
  employeeId: integer("employee_id").notNull().references(() => employeesTable.id),
  date: date("date", { mode: "string" }).notNull(),
  checkIn: timestamp("check_in", { withTimezone: true }),
  checkOut: timestamp("check_out", { withTimezone: true }),
  checkInLat: numeric("check_in_lat", { precision: 10, scale: 7 }),
  checkInLng: numeric("check_in_lng", { precision: 10, scale: 7 }),
  checkOutLat: numeric("check_out_lat", { precision: 10, scale: 7 }),
  checkOutLng: numeric("check_out_lng", { precision: 10, scale: 7 }),
  status: text("status").notNull().default("present"), // present, absent, half_day, leave
});

export const leavesTable = pgTable("leaves", {
  id: serial("id").primaryKey(),
  employeeId: integer("employee_id").notNull().references(() => employeesTable.id),
  fromDate: date("from_date", { mode: "string" }).notNull(),
  toDate: date("to_date", { mode: "string" }).notNull(),
  leaveType: text("leave_type").notNull(), // sick, casual, annual, other
  reason: text("reason"),
  status: text("status").notNull().default("pending"), // pending, approved, rejected
  approvedBy: integer("approved_by"),
  approvalNote: text("approval_note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertHierarchySchema = createInsertSchema(hierarchiesTable).omit({ id: true, createdAt: true });
export type InsertHierarchy = z.infer<typeof insertHierarchySchema>;
export type Hierarchy = typeof hierarchiesTable.$inferSelect;

export const insertEmployeeSchema = createInsertSchema(employeesTable).omit({ id: true, passwordHash: true, createdAt: true, updatedAt: true });
export type InsertEmployee = z.infer<typeof insertEmployeeSchema>;
export type Employee = typeof employeesTable.$inferSelect;
