#!/usr/bin/env bash
# Start VidPush locally (API + UI). Starts ngrok when TIKTOK_REDIRECT_URI uses an ngrok host.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

NO_NGROK=false
NO_OPEN=false

usage() {
  cat <<'EOF'
Usage: scripts/start-vidpush.sh [options]

Options:
  --no-ngrok   Skip ngrok (YouTube-only sessions; TikTok Connect will not work)
  --no-open    Do not open http://localhost:5173 in the browser
  -h, --help   Show this help

Double-click Start VidPush.command on macOS for the same behavior.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-ngrok) NO_NGROK=true; shift ;;
    --no-open) NO_OPEN=true; shift ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

load_node() {
  export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
  if [[ -s "$HOME/.nvm/nvm.sh" ]]; then
    # shellcheck disable=SC1091
    source "$HOME/.nvm/nvm.sh"
  fi
  if command -v fnm >/dev/null 2>&1; then
    eval "$(fnm env)"
  fi
}

pause_on_error() {
  local code=$1
  if [[ -t 0 ]] && [[ -t 1 ]]; then
    echo ""
    read -r -p "Press Enter to close..."
  fi
  exit "$code"
}

load_node

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20+ is required. Install from https://nodejs.org/ or: brew install node" >&2
  pause_on_error 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required but was not found on PATH." >&2
  pause_on_error 1
fi

if [[ ! -f .env ]]; then
  echo "Missing .env at repo root." >&2
  echo "Run: cp .env.example .env  then fill in your OAuth keys." >&2
  pause_on_error 1
fi

read_env_var() {
  local key=$1
  local default=${2:-}
  local line
  line=$(grep -E "^${key}=" .env 2>/dev/null | tail -n 1 || true)
  if [[ -z "$line" ]]; then
    echo "$default"
    return
  fi
  local value="${line#*=}"
  value="${value%$'\r'}"
  value="${value#\"}"
  value="${value%\"}"
  value="${value#\'}"
  value="${value%\'}"
  echo "$value"
}

PORT="$(read_env_var PORT 3000)"
FRONTEND_URL="$(read_env_var FRONTEND_URL "http://localhost:5173")"
NGROK_DOMAIN="$(read_env_var NGROK_DOMAIN "")"
TIKTOK_REDIRECT_URI="$(read_env_var TIKTOK_REDIRECT_URI "")"

if [[ ! -d node_modules ]]; then
  echo "Installing dependencies (first run)..."
  npm install
fi

NGROK_PID=""
cleanup() {
  if [[ -n "$NGROK_PID" ]] && kill -0 "$NGROK_PID" 2>/dev/null; then
    echo ""
    echo "Stopping ngrok..."
    kill "$NGROK_PID" 2>/dev/null || true
    wait "$NGROK_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

NGROK_HOST="$NGROK_DOMAIN"
if [[ -z "$NGROK_HOST" ]] && [[ "$TIKTOK_REDIRECT_URI" =~ ^https://([^/]+)/ ]]; then
  NGROK_HOST="${BASH_REMATCH[1]}"
fi

start_ngrok=false
if [[ "$NO_NGROK" == false ]] && [[ "$NGROK_HOST" == *ngrok* ]]; then
  if command -v ngrok >/dev/null 2>&1; then
    start_ngrok=true
  else
    echo "Note: TikTok redirect uses ngrok ($NGROK_HOST) but ngrok is not installed."
    echo "      TikTok Connect will not work until you run: brew install ngrok"
    echo ""
  fi
fi

if [[ "$start_ngrok" == true ]]; then
  echo "Starting ngrok → http://127.0.0.1:${PORT} (${NGROK_HOST})"
  ngrok http --url="$NGROK_HOST" "$PORT" &
  NGROK_PID=$!
  sleep 2
  echo ""
fi

echo "Starting VidPush (API :${PORT}, UI ${FRONTEND_URL})"
echo "Press Ctrl+C to stop."
echo ""

if [[ "$NO_OPEN" == false ]]; then
  (
    for _ in $(seq 1 30); do
      if curl -sf "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
        open "$FRONTEND_URL" 2>/dev/null || true
        exit 0
      fi
      sleep 1
    done
    open "$FRONTEND_URL" 2>/dev/null || true
  ) &
fi

npm run dev
