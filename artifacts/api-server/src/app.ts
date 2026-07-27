import express, { type Express, Request, Response, NextFunction } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { requireAuth } from "./middleware/auth";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

// ── CORS ──────────────────────────────────────────────────────────────────────
// In production set ALLOWED_ORIGINS to a comma-separated list of permitted
// frontend origins (e.g. "https://myapp.replit.app,https://myapp.com").
// In development (no env var) all origins are allowed so the Replit proxy
// preview and local tooling work without friction.
const configuredOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean)
  : [];

const corsOptions: Parameters<typeof cors>[0] = {
  // exposedHeaders: the browser must be able to read x-refreshed-token so the
  // client can transparently upgrade legacy session tokens to signed v2 tokens.
  exposedHeaders: ["x-refreshed-token"],
  origin: configuredOrigins.length > 0
    ? (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => {
        // Allow same-origin requests (no Origin header) and requests from
        // configured origins (or sub-domains thereof).
        if (!origin || configuredOrigins.some((ao) => origin === ao || origin.endsWith(`.${ao.replace(/^https?:\/\//, "")}`))) {
          cb(null, true);
        } else {
          cb(new Error(`CORS: origin "${origin}" is not allowed`));
        }
      }
    : true, // allow all in development / unset
};
app.use(cors(corsOptions));

// ── Body parsing ───────────────────────────────────────────────────────────
// 1 MB cap prevents memory-exhaustion attacks via enormous request bodies.
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

// ── Authentication guard ───────────────────────────────────────────────────
// All /api routes require a valid Bearer token except the health check,
// the login endpoint, and tokenized public invoice links (secured by their
// own HMAC-signed, time-limited tokens).
app.use("/api", (req, res, next) => {
  if (req.path === "/health") { next(); return; }
  if (req.path === "/auth/login" && req.method === "POST") { next(); return; }
  if (req.method === "GET" && req.path.startsWith("/public/invoices/")) { next(); return; }
  requireAuth(req, res, next);
});

app.use("/api", router);

// ── Global error handler ───────────────────────────────────────────────────
// Returns a standard JSON error envelope so clients always get a predictable
// shape regardless of where in the stack an error was thrown.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  if (err.message?.startsWith("CORS:")) {
    res.status(403).json({ error: err.message });
    return;
  }
  // Payload-too-large (body-parser)
  if ((err as any).type === "entity.too.large") {
    res.status(413).json({ error: "Request body too large (max 1 MB)" });
    return;
  }
  // Malformed JSON
  if ((err as any).type === "entity.parse.failed") {
    res.status(400).json({ error: "Request body is not valid JSON" });
    return;
  }
  logger.error({ err }, "Unhandled server error");
  res.status(500).json({ error: "An unexpected server error occurred" });
});

export default app;
