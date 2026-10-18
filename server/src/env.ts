import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
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
