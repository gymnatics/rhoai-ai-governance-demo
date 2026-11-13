#!/usr/bin/env bash
# B5: set the chatbot team's token limit live and measure time until Limitador enforces it.
# Usage: scripts/b5-set-limit.sh 3000   (demo)   |   scripts/b5-set-limit.sh 100000   (baseline)
source "$(dirname "$0")/lib.sh"
LIMIT=${1:?limit}
t0=$(date +%s)
oc patch maassubscription aigov-chatbot -n "$MAAS_NS" --type=json \
  -p "[{\"op\":\"replace\",\"path\":\"/spec/modelRefs/0/tokenRateLimits/0/limit\",\"value\":$LIMIT}]" >/dev/null
for i in $(seq 1 60); do
  if oc get limitador limitador -n kuadrant-system -o json | python3 -c "
import json,sys; d=json.load(sys.stdin)
sys.exit(0 if any(l.get('namespace','').startswith('$MODEL_NS/aigov-qwen3-8b') and l.get('max_value')==$LIMIT for l in d['spec'].get('limits',[])) else 1)"; then
    ok "limit $LIMIT tokens/min enforced by Limitador after $(( $(date +%s) - t0 ))s"; exit 0
  fi
  sleep 1
done
die "limit not visible in Limitador after 60s"
