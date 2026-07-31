import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { pool } from "@workspace/db";
import { censusDateColumns } from "../lib/dateColumns";

const router: IRouter = Router();

router.get("/healthz", (req, res) => {
  // Return 503 while startup migrations are still running so the deployment
  // startup probe keeps retrying rather than accepting a half-initialised server.
  if (!req.app.locals.migrationsReady) {
    res.status(503).json({ status: "starting" });
    return;
  }
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

/**
 * Schema census for the calendar-date columns.
 *
 * Deliberately unauthenticated and deliberately free of business data: it
 * returns nothing but column names and their live types. It exists because
 * verifying a deployment previously meant reading boot logs that production
 * discards; now one request answers "did the conversion land?" from outside.
 */
router.get("/healthz/schema", async (_req, res) => {
  try {
    const census = await censusDateColumns(pool);
    res.json({
      status: census.pending.length === 0 && census.missing.length === 0 ? "ok" : "pending",
      dateColumns: census,
    });
  } catch (e) {
    // The caller is unauthenticated, so it gets no database detail; the real
    // message goes to stderr, which production captures from process start.
    console.error("[healthz/schema] census failed:", (e as Error).message);
    res.status(500).json({ status: "error" });
  }
});

export default router;
