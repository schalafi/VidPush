"""Deploy with: modal deploy modal_app.py (see docs/modal.md)."""

from pathlib import Path
import os
import subprocess

import modal

ROOT = Path(__file__).resolve().parent
app = modal.App("vidpush")
data = modal.Volume.from_name("vidpush-data", create_if_missing=True)

# Explicit source allowlist: never send local secrets, tokens, or videos.
image = (
    modal.Image.from_registry("node:22-bookworm-slim", add_python="3.12")
    .apt_install("build-essential")
    .workdir("/app")
    .add_local_file(ROOT / "package.json", "/app/package.json", copy=True)
    .add_local_file(ROOT / "package-lock.json", "/app/package-lock.json", copy=True)
    .add_local_file(ROOT / "client/package.json", "/app/client/package.json", copy=True)
    .add_local_file(ROOT / "server/package.json", "/app/server/package.json", copy=True)
    .run_commands("npm ci")
    .add_local_dir(ROOT / "client/src", "/app/client/src", copy=True)
    .add_local_dir(ROOT / "server/src", "/app/server/src", copy=True)
)
for filename in ("client/index.html", "client/vite.config.ts", "client/tsconfig.json",
                 "client/tsconfig.node.json", "server/tsconfig.json"):
    image = image.add_local_file(ROOT / filename, f"/app/{filename}", copy=True)
image = image.run_commands("npm run build").env({
    "NODE_ENV": "production",
    "PORT": "3000",
    "COOKIE_SECURE": "true",
    "APP_AUTH_PROVIDER": "google",
    "DATA_DIR": "/data",
})


@app.function(
    image=image,
    secrets=[modal.Secret.from_name("vidpush-config", required_keys=[
        "FRONTEND_URL", "GOOGLE_ALLOWED_EMAIL",
        "GOOGLE_LOGIN_CLIENT_ID", "GOOGLE_LOGIN_CLIENT_SECRET",
        "GOOGLE_LOGIN_REDIRECT_URI",
        "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI",
        "TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET", "TIKTOK_REDIRECT_URI",
        "FACEBOOK_APP_ID", "FACEBOOK_APP_SECRET", "FACEBOOK_REDIRECT_URI",
        "INSTAGRAM_APP_ID", "INSTAGRAM_APP_SECRET", "INSTAGRAM_REDIRECT_URI",
    ])],
    volumes={"/data": data},
    # Single writer (SQLite plus in-memory queue). Scale to zero when idle,
    # but keep idle containers up to 15 minutes so short clip uploads can
    # finish. Long videos may not survive scale-down; the UI warns over 500 MB.
    min_containers=0,
    max_containers=1,
    scaledown_window=900,
    cpu=0.5,
    memory=1024,
    timeout=3600,
)
@modal.concurrent(max_inputs=100)
@modal.web_server(3000, startup_timeout=60)
def web():
    subprocess.Popen(["node", "server/dist/index.js"], cwd="/app", env=os.environ.copy())
