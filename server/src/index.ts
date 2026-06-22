import dotenv from "dotenv";
import fs from "fs";
import cors from "cors";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import authRoutes from "./routes/auth.js";
import uploadRoutes from "./routes/upload.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Monorepo: `npm run dev -w server` cwd is `server/`, so default dotenv misses root `.env`. */
const envCandidates = [
  path.join(__dirname, "..", "..", ".env"),
  path.join(__dirname, "..", ".env"),
  path.join(process.cwd(), ".env"),
];
for (const envPath of envCandidates) {
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
    break;
  }
}
dotenv.config();

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

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.use("/api/auth", authRoutes);
app.use("/api/upload", uploadRoutes);

app.listen(port, () => {
  console.log(`VidPush API http://localhost:${port}`);
});
