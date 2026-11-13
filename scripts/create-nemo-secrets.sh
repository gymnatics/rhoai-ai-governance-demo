#!/usr/bin/env bash
# Create/refresh Secret aigov-nemo-maas-keys (per-app MaaS keys held only by the guardrail server, never by the apps).
source "$(dirname "$0")/lib.sh"; load_secrets
oc create secret generic aigov-nemo-maas-keys -n "$DEMO_NS" \
  --from-literal=chatbot="$APP_CHATBOT_KEY" --from-literal=idocr="$APP_IDOCR_KEY" --from-literal=collections="$APP_COLLECTIONS_KEY" \
  --dry-run=client -o yaml | oc apply -f - >/dev/null
oc label secret aigov-nemo-maas-keys -n "$DEMO_NS" app.kubernetes.io/part-of="$PART_OF" --overwrite >/dev/null
ok "secret aigov-nemo-maas-keys (keys: chatbot, idocr, collections)"
