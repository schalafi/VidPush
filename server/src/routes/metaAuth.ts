import { Router } from "express";
import { db, deleteTokens, upsertTokens } from "../db.js";
import { beginOAuth, finishOAuth } from "../oauthState.js";
import { exchangeFacebook, exchangeInstagram, metaAuthUrl, metaConfigured } from "../oauth/meta.js";
import { SESSION_COOKIE } from "../middleware/apiAuth.js";
import { startFacebookHandoff, acceptFacebookHandoff, finishFacebookHandoff, readFacebookHandoff, deleteFacebookHandoff } from "../facebookHandoff.js";
const router = Router();
const user = () => process.env.DEFAULT_USER_ID ?? "default";
const frontend = () => process.env.FRONTEND_URL ?? "http://localhost:5173";
function savePages(userId: string, result: Awaited<ReturnType<typeof exchangeFacebook>>) {
  db.transaction(() => {
    db.prepare("DELETE FROM facebook_pages WHERE user_id = ?").run(userId);
    const insert = db.prepare("INSERT INTO facebook_pages (user_id, id, name, access_token, expires_at) VALUES (?, ?, ?, ?, ?)");
    for (const page of result.pages) insert.run(userId, page.id, page.name, page.access_token, result.expiresAt);
  })();
}
router.post("/facebook/handoff", (req, res) => {
  if (!metaConfigured("facebook")) { res.status(400).json({ error: "Facebook setup is not complete" }); return; }
  const pending = startFacebookHandoff(req.cookies[SESSION_COOKIE], user());
  res.json({ id: pending.id, url: metaAuthUrl("facebook", pending.state) });
});
router.post("/facebook/handoff/:id/claim", (req, res) => {
  const item = readFacebookHandoff(req.params.id, req.cookies[SESSION_COOKIE]);
  if (!item) { res.status(410).json({ error: "Connection expired. Click Connect to try again." }); return; }
  if (item.status === "ready" && item.result) {
    savePages(item.userId, item.result);
    deleteFacebookHandoff(item.id);
    res.json({ status: "ready" }); return;
  }
  res.json({ status: item.status, error: item.error });
});
for (const platform of ["facebook", "instagram"] as const) {
  router.get(`/${platform}/start`, (_req, res) => {
    if (!metaConfigured(platform)) { res.redirect(`${frontend()}/?oauth=${platform}_error&message=Setup%20is%20not%20complete`); return; }
    const { state } = beginOAuth(res, platform, user());
    res.redirect(metaAuthUrl(platform, state));
  });
  router.get([`/${platform}/callback`, `/${platform}/complete`], async (req, res) => {
    if (platform === "facebook" && typeof req.query.state === "string" && req.query.state.startsWith("fbh_")) {
      const item = acceptFacebookHandoff(req.query.state);
      let success = false;
      if (item) {
        try {
          if (req.query.error || typeof req.query.code !== "string") throw new Error("Facebook authorization was cancelled. Try connecting again.");
          finishFacebookHandoff(item, await exchangeFacebook(req.query.code));
          success = true;
        } catch (error) {
          finishFacebookHandoff(item, undefined, error instanceof Error ? error.message : "Facebook connection failed.");
        }
      }
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
      res.type("html").send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>VidPush — Facebook authorization</title></head><body style="font:18px system-ui;max-width:600px;margin:80px auto;padding:24px"><h1>${success ? "Facebook authorization received" : "Connection could not be completed"}</h1><p>${success ? "Return to your original VidPush tab and choose your Facebook Page. You can close this tab." : "Return to your original VidPush tab and start a new connection."}</p></body></html>`);
      return;
    }
    const pending = finishOAuth(req, res, platform);
    if (!pending || req.query.error || typeof req.query.code !== "string") {
      res.redirect(`${frontend()}/?oauth=${platform}_error&message=Authorization%20was%20cancelled%20or%20expired`); return;
    }
    try {
      if (platform === "facebook") {
        const { pages, expiresAt } = await exchangeFacebook(req.query.code);
        db.transaction(() => {
          db.prepare("DELETE FROM facebook_pages WHERE user_id = ?").run(pending.userId);
          const insert = db.prepare("INSERT INTO facebook_pages (user_id, id, name, access_token, expires_at) VALUES (?, ?, ?, ?, ?)");
          for (const page of pages) insert.run(pending.userId, page.id, page.name, page.access_token, expiresAt);
        })();
        res.redirect(`${frontend()}/?oauth=facebook_choose`);
      } else {
        const account = await exchangeInstagram(req.query.code);
        upsertTokens(pending.userId, platform, account.token, null, account.expiresAt, account.id, account.name);
        res.redirect(`${frontend()}/?oauth=instagram_ok`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Connection failed";
      res.redirect(`${frontend()}/?oauth=${platform}_error&message=${encodeURIComponent(message)}`);
    }
  });
  router.delete(`/${platform}`, (_req, res) => {
    deleteTokens(user(), platform);
    if (platform === "facebook") db.prepare("DELETE FROM facebook_pages WHERE user_id = ?").run(user());
    res.json({ ok: true });
  });
}
router.post("/facebook/page", (req, res) => {
  if (typeof req.body.pageId !== "string") { res.status(400).json({ error: "Choose a Facebook Page" }); return; }
  const page = db.prepare("SELECT * FROM facebook_pages WHERE user_id = ? AND id = ? AND (expires_at IS NULL OR expires_at > ?)")
    .get(user(), req.body.pageId, Date.now()) as { id: string; name: string; access_token: string; expires_at: number | null } | undefined;
  if (!page) { res.status(400).json({ error: "Reconnect Facebook and choose an authorized Page" }); return; }
  upsertTokens(user(), "facebook", page.access_token, null, page.expires_at, page.id, page.name);
  res.json({ ok: true });
});
export default router;
