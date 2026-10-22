// Vercel serverless entry point.
//
// Deliberately imports ONLY ./app — never ./index. index.ts runs schema
// migrations, data repairs and destructive cleanups (e.g. wipeCalicutTransactions)
// at boot; on Vercel that would execute against production on every cold start.
// Schema changes must be applied separately before deploying.
//
// The in-process setInterval schedulers from index.ts cannot run on serverless,
// so they are exposed here as /api/cron/* endpoints triggered by Vercel Cron.
import express, { type Request, type Response } from "express";
import { pool } from "@workspace/db";
import app from "./app";
import { runRentAccrual } from "./lib/rentAccrual";
import { runSalaryAccrual } from "./lib/salaryAccrual";
import { ensureDailyStockClosures } from "./lib/dailyStockClosures";

const jobs: Record<string, () => Promise<unknown>> = {
  "rent-accrual": () => runRentAccrual(pool),
  "salary-accrual": () => runSalaryAccrual(pool),
  "stock-close": () => ensureDailyStockClosures(pool),
};

const server = express();

server.get("/api/cron/:job", async (req: Request, res: Response) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const name = String(req.params.job);
  const job = jobs[name];
  if (!job) {
    res.status(404).json({ error: "Unknown job" });
    return;
  }
  try {
    const result = await job();
    res.json({ ok: true, job: name, result });
  } catch (err) {
    console.error(`[cron] ${name} failed:`, err);
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

server.use(app);

export default server;
