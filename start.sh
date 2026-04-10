#!/bin/bash
set -e

echo "[start] Claude Code Discord Bot starting..."

# Start Claude in a tmux session using the restart loop
tmux new-session -d -s claude "bash /restart-loop.sh"

# Auto-accept Claude's startup prompts (trust dialog + permissions warning).
# These only appear on first run or after a rebuild.
for i in $(seq 1 20); do
  sleep 2
  OUTPUT=$(tmux capture-pane -t claude -p 2>/dev/null || true)

  if echo "$OUTPUT" | grep -q "Is this a project you created"; then
    tmux send-keys -t claude '' Enter
  elif echo "$OUTPUT" | grep -q "Yes, I accept"; then
    tmux send-keys -t claude j ''
    sleep 0.5
    tmux send-keys -t claude '' Enter
  elif echo "$OUTPUT" | grep -q "bypass permissions on\|Listening for channel"; then
    echo "[start] Claude is running."
    break
  fi
done

# Cron runner — with auto-restart if it crashes
echo "[start] Starting cron runner..."
tmux new-window -t claude -n cron \
  "while true; do node /workspace/scripts/cron-runner.js 2>&1 | tee -a /workspace/crons/logs/cron-runner.log; echo '[cron] restarting in 10s...'; sleep 10; done"

# Discord slash command handler — with auto-restart if it crashes
echo "[start] Starting slash command handler..."
tmux new-window -t claude -n slash \
  "while true; do node /workspace/scripts/discord-slash-handler.js 2>&1 | tee -a /workspace/crons/logs/slash-handler.log; echo '[slash] restarting in 10s...'; sleep 10; done"

echo "[start] All sessions running."
echo "  Attach to Claude:  docker exec -it claude-bot tmux attach -t claude:0"
echo "  Attach to crons:   docker exec -it claude-bot tmux attach -t claude:cron"
echo "  Attach to slashs:  docker exec -it claude-bot tmux attach -t claude:slash"

# Keep container alive
tail -f /dev/null
