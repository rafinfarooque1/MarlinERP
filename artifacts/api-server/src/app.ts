import express, { type Express } from "express";
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
// exposedHeaders: the browser must be able to read x-refreshed-token so the
// client can transparently upgrade legacy session tokens to signed v2 tokens.
app.use(cors({ exposedHeaders: ["x-refreshed-token"] }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Global authentication guard — all /api routes require a valid Bearer token
// except the health check, the login endpoint, and tokenized public invoice
// links (secured by their own HMAC-signed, time-limited tokens).
app.use("/api", (req, res, next) => {
  if (req.path === "/health") { next(); return; }
  if (req.path === "/auth/login" && req.method === "POST") { next(); return; }
  if (req.method === "GET" && req.path.startsWith("/public/invoices/")) { next(); return; }
  requireAuth(req, res, next);
});

app.use("/api", router);

export default app;
