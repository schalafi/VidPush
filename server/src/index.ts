import "./env.js";
import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { requireAuthConfigured, requireAuth } from "./middleware/apiAuth.js";
import metaAuthRoutes from "./routes/metaAuth.js";
import authRoutes from "./routes/auth.js";
import uploadRoutes from "./routes/upload.js";
import scheduledRoutes from "./routes/scheduled.js";
import { publicFileRouter } from "./publicFiles.js";
import { startScheduler } from "./scheduler.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
requireAuthConfigured();

const app = express();
const port = Number(process.env.PORT ?? 3000);
const frontend = process.env.FRONTEND_URL ?? "http://localhost:5173";

app.use(
  cors({
    origin: frontend,
    credentials: true,
  })
);

app.use(express.json());
app.use(cookieParser());

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

// Keep the unlock page and its assets public; protect API requests below.
const clientDir = path.join(__dirname, "..", "..", "client", "dist");
if (process.env.NODE_ENV === "production") {
  app.use(express.static(clientDir));
}
// Temporary Instagram video_url links carry unguessable tokens instead of a
// session (Meta's servers fetch them), so this stays outside requireAuth.
app.use("/api/upload/public", publicFileRouter);
app.use((req, res, next) => {
  if (req.path === "/api" || req.path.startsWith("/api/")) {
    requireAuth(req, res, next);
  } else {
    next();
  }
});
app.use("/api/auth", authRoutes);
app.use("/api/auth", metaAuthRoutes);
app.use("/api/upload", uploadRoutes);
app.use("/api/scheduled", scheduledRoutes);
startScheduler();
app.use("/api", (_req, res) => res.status(404).json({ error: "Not found" }));
if (process.env.NODE_ENV === "production") {
  app.get("*", (_req, res) => res.sendFile(path.join(clientDir, "index.html")));
}

app.listen(port, () => {
  console.log(`VidPush API http://localhost:${port}`);
});
