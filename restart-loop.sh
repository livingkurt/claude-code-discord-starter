#!/bin/bash
# Keeps Claude Code running and restarts it if it exits.
# Reads the model preference from data/current-model.json so /model slash
# command changes persist across restarts.

MODEL_STATE="/workspace/data/current-model.json"

get_model() {
  if [ -f "$MODEL_STATE" ]; then
    node -e "try{process.stdout.write(JSON.parse(require('fs').readFileSync('$MODEL_STATE','utf8')).model||'sonnet')}catch(e){process.stdout.write('sonnet')}"
  else
    echo "sonnet"
  fi
}

while true; do
  MODEL=$(get_model)
  echo "[$(date)] Starting Claude Code with model: $MODEL"
  claude --dangerously-skip-permissions --model "$MODEL" \
    --channels plugin:discord@claude-plugins-official
  echo "[$(date)] Claude exited. Restarting in 10s..."
  sleep 10
done
