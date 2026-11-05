#!/usr/bin/env bash
# Start StudyHub.
#   ./run.sh          laptop only (opens the browser)
#   ./run.sh phone    also reachable from your phone on the same Wi-Fi
cd "$(dirname "$0")"
PORT=${PORT:-8000}
if [ "$1" = "phone" ]; then
  exec python3 "$(dirname "$0")/serve.py" --phone --port "$PORT"
fi
( sleep 1; xdg-open "http://localhost:$PORT/" >/dev/null 2>&1 ) &
exec python3 "$(dirname "$0")/serve.py" --port "$PORT"
