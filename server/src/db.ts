import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR ?? path.join(__dirname, "..", "..", ".data");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const dbPath = path.join(dataDir, "vidpush.db");
export const db = new Database(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, subject TEXT NOT NULL, email TEXT NOT NULL,
    provider TEXT NOT NULL, expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS oauth_accounts (
    user_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    access_token TEXT NOT NULL,
    refresh_token TEXT,
    expires_at INTEGER,
    open_id TEXT,
    PRIMARY KEY (user_id, provider),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

const defaultUser = db.prepare("SELECT id FROM users WHERE id = ?").get("default");
if (!defaultUser) {
  db.prepare("INSERT INTO users (id) VALUES (?)").run("default");
}

// Additive migration preserves pre-existing publishing credentials.
const columns = db.prepare("PRAGMA table_info(oauth_accounts)").all() as { name: string }[];
if (!columns.some(c => c.name === "account_name")) db.exec("ALTER TABLE oauth_accounts ADD COLUMN account_name TEXT");
db.exec(`CREATE TABLE IF NOT EXISTS facebook_pages (
  user_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, access_token TEXT NOT NULL,
  expires_at INTEGER, PRIMARY KEY (user_id, id)
)`);
export type OauthProvider = "youtube" | "tiktok" | "facebook" | "instagram";

export type OauthRow = {
  user_id: string;
  provider: string;
  access_token: string;
  refresh_token: string | null;
  expires_at: number | null;
  open_id: string | null;
  account_name: string | null;
};

export function getTokens(userId: string, provider: OauthProvider): OauthRow | undefined {
  return db
    .prepare("SELECT * FROM oauth_accounts WHERE user_id = ? AND provider = ?")
    .get(userId, provider) as OauthRow | undefined;
}

export function upsertTokens(
  userId: string,
  provider: OauthProvider,
  accessToken: string,
  refreshToken: string | null,
  expiresAt: number | null,
  openId: string | null,
  accountName: string | null = null
): void {
  db.prepare(
    `INSERT INTO oauth_accounts (user_id, provider, access_token, refresh_token, expires_at, open_id, account_name)
     VALUES (@userId, @provider, @accessToken, @refreshToken, @expiresAt, @openId, @accountName)
     ON CONFLICT(user_id, provider) DO UPDATE SET
       access_token = excluded.access_token,
       refresh_token = COALESCE(excluded.refresh_token, oauth_accounts.refresh_token),
       expires_at = excluded.expires_at,
       open_id = COALESCE(excluded.open_id, oauth_accounts.open_id),
       account_name = COALESCE(excluded.account_name, oauth_accounts.account_name)`
  ).run({
    userId,
    provider,
    accessToken,
    refreshToken,
    expiresAt,
    openId,
    accountName,
  });
}

export function deleteTokens(userId: string, provider: OauthProvider): void {
  db.prepare("DELETE FROM oauth_accounts WHERE user_id = ? AND provider = ?").run(userId, provider);
}
