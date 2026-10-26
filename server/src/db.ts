import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDirValue = process.env.DATA_DIR ?? path.join(__dirname, "..", "..", ".data");
if (!fs.existsSync(dataDirValue)) fs.mkdirSync(dataDirValue, { recursive: true });

export function dataDir(): string {
  return dataDirValue;
}

const dbPath = path.join(dataDirValue, "vidpush.db");
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
db.exec(`CREATE TABLE IF NOT EXISTS scheduled_posts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  original_name TEXT NOT NULL,
  size INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  destinations TEXT NOT NULL,
  publish_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled',
  job_id TEXT,
  error TEXT,
  created_at INTEGER NOT NULL
)`);
// Additive migration: timestamp terminal transitions for retention pruning.
const schedCols = db.prepare("PRAGMA table_info(scheduled_posts)").all() as { name: string }[];
if (!schedCols.some(c => c.name === "completed_at")) db.exec("ALTER TABLE scheduled_posts ADD COLUMN completed_at INTEGER");

export type OauthProvider = "youtube" | "tiktok" | "facebook" | "instagram";

export type ScheduledStatus = "scheduled" | "uploading" | "done" | "error" | "cancelled";

export type ScheduledRow = {
  id: string;
  user_id: string;
  file_path: string;
  original_name: string;
  size: number;
  title: string;
  description: string;
  destinations: string;
  publish_at: number;
  status: ScheduledStatus;
  job_id: string | null;
  error: string | null;
  created_at: number;
  completed_at: number | null;
};

export function createScheduled(row: Omit<ScheduledRow, "status" | "job_id" | "error" | "completed_at">): ScheduledRow {
  const full: ScheduledRow = { ...row, status: "scheduled", job_id: null, error: null, completed_at: null };
  db.prepare(
    `INSERT INTO scheduled_posts (id, user_id, file_path, original_name, size, title, description, destinations, publish_at, status, job_id, error, created_at)
     VALUES (@id, @user_id, @file_path, @original_name, @size, @title, @description, @destinations, @publish_at, @status, @job_id, @error, @created_at)`
  ).run(full);
  return full;
}

export function listScheduled(userId: string): ScheduledRow[] {
  return db
    .prepare("SELECT * FROM scheduled_posts WHERE user_id = ? ORDER BY publish_at ASC")
    .all(userId) as ScheduledRow[];
}

export function getScheduled(id: string): ScheduledRow | undefined {
  return db.prepare("SELECT * FROM scheduled_posts WHERE id = ?").get(id) as ScheduledRow | undefined;
}

export function updateScheduledTime(id: string, publishAt: number): void {
  db.prepare("UPDATE scheduled_posts SET publish_at = ? WHERE id = ?").run(publishAt, id);
}

const TERMINAL_STATES: ReadonlySet<ScheduledStatus> = new Set(["done", "error", "cancelled"]);

export function setScheduledState(id: string, status: ScheduledStatus, error: string | null = null): void {
  if (TERMINAL_STATES.has(status)) {
    db.prepare("UPDATE scheduled_posts SET status = ?, error = ?, completed_at = ? WHERE id = ?")
      .run(status, error, Date.now(), id);
  } else {
    db.prepare("UPDATE scheduled_posts SET status = ?, error = ? WHERE id = ?").run(status, error, id);
  }
}

/**
 * Remove finished rows (done/cancelled) older than cutoffMs. Rows pre-dating
 * the completed_at column fall back to publish_at/created_at. Failed rows are
 * never pruned: they need a human decision. Returns the removed ids.
 */
export function pruneTerminalScheduled(cutoffMs: number): string[] {
  const rows = db.prepare(
    `SELECT id, file_path FROM scheduled_posts
     WHERE status IN ('done', 'cancelled')
       AND COALESCE(completed_at, publish_at, created_at) < ?`
  ).all(cutoffMs) as { id: string; file_path: string }[];
  for (const row of rows) {
    db.prepare("DELETE FROM scheduled_posts WHERE id = ?").run(row.id);
    fs.unlink(row.file_path, () => {});
  }
  return rows.map(r => r.id);
}

export function setScheduledJob(id: string, jobId: string): void {
  db.prepare("UPDATE scheduled_posts SET job_id = ? WHERE id = ?").run(jobId, id);
}

export function deleteScheduled(id: string): void {
  db.prepare("DELETE FROM scheduled_posts WHERE id = ?").run(id);
}

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
