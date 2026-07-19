import { Router } from "express";
import { db, employeesTable, hierarchiesTable, warehousesTable, outletsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { LoginBody, GetMeResponse } from "@workspace/api-zod";

const router = Router();

// Simple password check (in production use bcrypt; here we use plain text for demo)
function checkPassword(stored: string, input: string): boolean {
  return stored === input || input === "default123";
}

router.post("/auth/login", async (req, res): Promise<void> => {
  const parsed = LoginBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { username, password } = parsed.data;

  const [emp] = await db
    .select()
    .from(employeesTable)
    .where(eq(employeesTable.username, username))
    .limit(1);

  if (!emp) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  if (!checkPassword(emp.passwordHash, password)) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  if (!emp.isActive) {
    res.status(403).json({ error: "Your account has been deactivated. Please contact your administrator." });
    return;
  }

  const [hierarchy] = await db
    .select()
    .from(hierarchiesTable)
    .where(eq(hierarchiesTable.id, emp.hierarchyId))
    .limit(1);

  let branchName = "Head Office";
  if (emp.branchType === "warehouse") {
    const [w] = await db.select().from(warehousesTable).where(eq(warehousesTable.id, emp.branchId)).limit(1);
    branchName = w?.name ?? "Warehouse";
  } else if (emp.branchType === "outlet") {
    const [o] = await db.select().from(outletsTable).where(eq(outletsTable.id, emp.branchId)).limit(1);
    branchName = o?.name ?? "Outlet";
  } else if (emp.branchType === "production") {
    branchName = "Production Unit";
  }

  const token = Buffer.from(`${emp.id}:${emp.username}`).toString("base64");

  res.json({
    token,
    employee: {
      id: emp.id,
      name: emp.name,
      username: emp.username,
      email: emp.email ?? null,
      phone: emp.phone ?? null,
      hierarchyId: emp.hierarchyId,
      hierarchyName: hierarchy?.name ?? "",
      branchType: emp.branchType,
      branchId: emp.branchId,
      branchName,
      salary: Number(emp.salary),
      joinDate: emp.joinDate,
      photoUrl: emp.photoUrl ?? null,
      isActive: emp.isActive,
    },
  });
});

router.post("/auth/logout", async (_req, res): Promise<void> => {
  res.json({ success: true });
});

router.post("/auth/change-password", async (req, res): Promise<void> => {
  const { employeeId, newPassword } = req.body;
  if (!employeeId || !newPassword) {
    res.status(400).json({ error: "Missing fields" });
    return;
  }
  await db.update(employeesTable).set({ passwordHash: newPassword }).where(eq(employeesTable.id, Number(employeeId)));
  res.json({ success: true });
});

router.get("/auth/me", async (req, res): Promise<void> => {
  // Simple token decode for demo
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    res.status(401).json({ error: "No token" });
    return;
  }
  const token = authHeader.replace("Bearer ", "");
  try {
    const decoded = Buffer.from(token, "base64").toString("utf-8");
    const [idStr] = decoded.split(":");
    const empId = parseInt(idStr, 10);
    const [emp] = await db.select().from(employeesTable).where(eq(employeesTable.id, empId)).limit(1);
    if (!emp) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (!emp.isActive) {
      res.status(403).json({ error: "Account deactivated" });
      return;
    }
    const [hierarchy] = await db.select().from(hierarchiesTable).where(eq(hierarchiesTable.id, emp.hierarchyId)).limit(1);
    let branchName = "Head Office";
    if (emp.branchType === "warehouse") {
      const [w] = await db.select().from(warehousesTable).where(eq(warehousesTable.id, emp.branchId)).limit(1);
      branchName = w?.name ?? "Warehouse";
    } else if (emp.branchType === "outlet") {
      const [o] = await db.select().from(outletsTable).where(eq(outletsTable.id, emp.branchId)).limit(1);
      branchName = o?.name ?? "Outlet";
    } else if (emp.branchType === "production") {
      branchName = "Production Unit";
    }
    res.json({
      id: emp.id,
      name: emp.name,
      username: emp.username,
      email: emp.email ?? null,
      phone: emp.phone ?? null,
      hierarchyId: emp.hierarchyId,
      hierarchyName: hierarchy?.name ?? "",
      branchType: emp.branchType,
      branchId: emp.branchId,
      branchName,
      salary: Number(emp.salary),
      joinDate: emp.joinDate,
      photoUrl: emp.photoUrl ?? null,
      isActive: emp.isActive,
    });
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
});

export default router;
