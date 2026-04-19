#!/bin/bash
# Keeps Claude Code running and restarts it if it exits.
#
# Key behaviors beyond a simple restart loop:
#   1. Session ID persistence — saves the last session UUID so --resume
#      restores full conversation context after a model switch or restart.
#      Without this, every restart starts a fresh context.
#   2. Model persistence — reads model preference from current-model.json
#      so /model slash command changes survive restarts.
#
# State files (under /workspace):
#   data/current-model.json       — { "model": "sonnet" | "opus" | ... }
#   data/interactive-session-id   — last good session UUID (single line)

MODEL_STATE="/workspace/data/current-model.json"
SESSION_ID_FILE="/workspace/data/interactive-session-id"
TRANSCRIPT_DIR="/home/node/.claude/projects/-workspace"
MIN_TRANSCRIPT_SIZE="+10k"   # ignore stub/empty transcripts

get_model() {
  if [ -f "$MODEL_STATE" ]; then
    node -e "try{process.stdout.write(JSON.parse(require('fs').readFileSync('$MODEL_STATE','utf8')).model||'sonnet')}catch(e){process.stdout.write('sonnet')}"
  else
    echo "sonnet"
  fi
}

capture_session_id() {
  # Pin the newest non-trivial transcript as the resume target for next loop.
  local newest
  newest=$(find "$TRANSCRIPT_DIR" -maxdepth 1 -name '*.jsonl' -size "$MIN_TRANSCRIPT_SIZE" -printf '%T@ %f\n' 2>/dev/null \
    | sort -rn | head -1 | awk '{print $2}' | sed 's/\.jsonl$//')
  if [ -n "$newest" ]; then
    echo "$newest" > "$SESSION_ID_FILE"
    echo "[$(date)] Captured session ID: $newest"
  fi
}

mkdir -p "$(dirname "$SESSION_ID_FILE")"

while true; do
  MODEL=$(get_model)
  SESSION_ID=""
  if [ -f "$SESSION_ID_FILE" ]; then
    SESSION_ID=$(tr -d '[:space:]' < "$SESSION_ID_FILE")
  fi

  if [ -n "$SESSION_ID" ] && [ -s "$TRANSCRIPT_DIR/${SESSION_ID}.jsonl" ]; then
    echo "[$(date)] Resuming session $SESSION_ID with model: $MODEL"
    claude --dangerously-skip-permissions --model "$MODEL" \
      --channels plugin:discord@claude-plugins-official \
      --resume "$SESSION_ID"
  else
    echo "[$(date)] Starting fresh session with model: $MODEL"
    claude --dangerously-skip-permissions --model "$MODEL" \
      --channels plugin:discord@claude-plugins-official
  fi

  capture_session_id
  echo "[$(date)] Claude exited. Restarting in 10s..."
  sleep 10
done
