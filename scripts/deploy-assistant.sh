#!/usr/bin/env bash
# Build and deploy the bank assistant (Chainlit sample app) into $DEMO_NS.
# Needs the guardrails and the aigov-app ServiceAccount from scripts/setup.sh.
# Usage: scripts/deploy-assistant.sh [--no-build]
#   --no-build   only refresh the Secret and manifests (reuse the last image)
# Login for the app: user "demo", password in .secrets/assistant.env (generated on first run).
source "$(dirname "$0")/lib.sh"; load_secrets
BUILD=true; [ "${1:-}" = "--no-build" ] && BUILD=false

oc get sa aigov-app -n "$DEMO_NS" >/dev/null 2>&1 || die "ServiceAccount aigov-app not found in $DEMO_NS (run scripts/setup.sh first)"

# app login (generated once, kept locally)
mkdir -p "$SECRETS_DIR"; chmod 700 "$SECRETS_DIR"
if [ ! -f "$SECRETS_DIR/assistant.env" ]; then
  (umask 077; printf 'ASSISTANT_USER=demo\nASSISTANT_PASSWORD=%s\nCHAINLIT_AUTH_SECRET=%s\n' "$(openssl rand -hex 8)" "$(openssl rand -hex 32)" > "$SECRETS_DIR/assistant.env")
fi
set -a; source "$SECRETS_DIR/assistant.env"; set +a

log "secret aigov-assistant-env"
for i in $(seq 1 20); do [ -n "$(oc get secret aigov-app-token -n "$DEMO_NS" -o jsonpath='{.data.token}' 2>/dev/null)" ] && break; sleep 2; done
APP_TOKEN=$(oc get secret aigov-app-token -n "$DEMO_NS" -o jsonpath='{.data.token}' | base64 -d)
[ -n "$APP_TOKEN" ] || die "no token in secret aigov-app-token"
oc create secret generic aigov-assistant-env -n "$DEMO_NS" \
  --from-literal=NEMO_URL="$NEMO_URL" --from-literal=NEMO_TOKEN="$APP_TOKEN" --from-literal=NEMO_MODEL="$MODEL_ID" \
  --from-literal=MLFLOW_TRACKING_URI="$DASH_URL/mlflow" --from-literal=MLFLOW_TRACKING_TOKEN="$APP_TOKEN" \
  --from-literal=MLFLOW_WORKSPACE="$DEMO_NS" --from-literal=DASH_URL="$DASH_URL" \
  --from-literal=ASSISTANT_USER="$ASSISTANT_USER" --from-literal=ASSISTANT_PASSWORD="$ASSISTANT_PASSWORD" \
  --from-literal=CHAINLIT_AUTH_SECRET="$CHAINLIT_AUTH_SECRET" \
  --dry-run=client -o yaml | oc apply -f - >/dev/null
oc label secret aigov-assistant-env -n "$DEMO_NS" app.kubernetes.io/part-of="$PART_OF" --overwrite >/dev/null

log "manifests"
apply_manifest "$REPO_DIR/manifests/40-assistant.yaml" >/dev/null

if $BUILD; then
  log "build (in-cluster, ~3-5 min)"
  CTX=$(mktemp -d); trap 'rm -rf "$CTX"' EXIT
  cp "$REPO_DIR"/app/{app.py,chainlit.md,requirements.txt,Containerfile} "$CTX/"
  cp "$REPO_DIR"/notebooks/{harness.py,audit_client.py} "$CTX/"
  oc start-build aigov-assistant -n "$DEMO_NS" --from-dir="$CTX" --follow --wait >/dev/null || die "build failed: oc logs -n $DEMO_NS bc/aigov-assistant"
fi
oc rollout restart deploy/aigov-assistant -n "$DEMO_NS" >/dev/null
oc rollout status deploy/aigov-assistant -n "$DEMO_NS" --timeout=300s >/dev/null || die "assistant not ready: oc logs -n $DEMO_NS deploy/aigov-assistant"
ok "assistant: https://$(oc get route aigov-assistant -n "$DEMO_NS" -o jsonpath='{.spec.host}')  (user $ASSISTANT_USER, password in $SECRETS_DIR/assistant.env)"
