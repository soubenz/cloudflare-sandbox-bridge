#!/usr/bin/env bash
# Outcome-based: checks the file's content, not how it was produced.
set -uo pipefail
FILE=/workspace/greeting.txt
if [ ! -f "$FILE" ]; then
  echo '{"pass": false, "message": "greeting.txt does not exist"}'
  exit 1
fi
content=$(cat "$FILE")
if [ "$content" = "$GREETING" ]; then
  echo '{"pass": true, "message": "greeting.txt matches GREETING"}'
  exit 0
else
  echo "{\"pass\": false, \"message\": \"greeting.txt contains '$content', expected '$GREETING'\"}"
  exit 1
fi
