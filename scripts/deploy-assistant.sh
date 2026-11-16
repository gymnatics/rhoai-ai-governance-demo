#!/usr/bin/env bash
# Build and deploy the bank assistant (Chainlit sample app) into $DEMO_NS.
# Needs the guardrails and the aigov-app ServiceAccount from scripts/setup.sh.
# Usage: scripts/deploy-assistant.sh [--no-build | --rebuild]
#   Idempotent: builds only when app/ or the audit client changed, restarts only when the image or Secret changed.
#   --no-build   never build (reuse the last image)    --rebuild   build even if nothing changed
# Login for the app: user "demo", password in .secrets/assistant.env (generated on first run).
source "$(dirname "$0")/lib.sh"; load_secrets
BUILD=true; FORCE=false
for a in "$@"; do case "$a" in --no-build) BUILD=false;; --rebuild) FORCE=true;; *) echo "unknown option $a (use --no-build or --rebuild)" >&2; exit 1;; esac; done

oc get sa aigov-app -n "$DEMO_NS" >/dev/null 2>&1 || die "ServiceAccount aigov-app not found in $DEMO_NS (run scripts/setup.sh first)"

# app login (generated once, kept locally)
mkdir -p "$SECRETS_DIR"; chmod 700 "$SECRETS_DIR"
if [ ! -f "$SECRETS_DIR/assistant.env" ]; then
  (umask 077; printf 'ASSISTANT_USER=demo\nASSISTANT_PASSWORD=%s\nCHAINLIT_AUTH_SECRET=%s\n' "$(openssl rand -hex 8)" "$(openssl rand -hex 32)" > "$SECRETS_DIR/assistant.env")
fi
set -a; source "$SECRETS_DIR/assistant.env"; set +a
if [ -z "${CHAINLIT_AUTH_SECRET:-}" ]; then   # keep the session key already on the cluster, else create one
  CHAINLIT_AUTH_SECRET=$(oc get secret aigov-assistant-env -n "$DEMO_NS" -o jsonpath='{.data.CHAINLIT_AUTH_SECRET}' 2>/dev/null | base64 -d)
  [ -n "$CHAINLIT_AUTH_SECRET" ] || CHAINLIT_AUTH_SECRET=$(openssl rand -hex 32)
fi

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

log "manifests (OpenTelemetry collector for the SIEM copy, assistant)"
apply_manifest "$REPO_DIR/manifests/42-audit-otel-collector.yaml" >/dev/null || warn "OpenTelemetry collector not created (is the Red Hat build of OpenTelemetry installed?); MLflow audit still works"
apply_manifest "$REPO_DIR/manifests/40-assistant.yaml" >/dev/null

if $BUILD; then
  log "image"
  CTX=$(mktemp -d); trap 'rm -rf "$CTX"' EXIT
  cp "$REPO_DIR"/app/{app.py,chainlit.md,requirements.txt,Containerfile} "$CTX/"
  cp "$REPO_DIR"/notebooks/{harness.py,audit_client.py} "$CTX/"
  build_if_changed aigov-assistant "$DEMO_NS" "$CTX" $FORCE || die "build failed: oc logs -n $DEMO_NS bc/aigov-assistant"
fi
roll_if_config_changed aigov-assistant "$DEMO_NS" aigov-assistant-env
oc rollout status deploy/aigov-assistant -n "$DEMO_NS" --timeout=300s >/dev/null || die "assistant not ready: oc logs -n $DEMO_NS deploy/aigov-assistant"
ok "assistant: https://$(oc get route aigov-assistant -n "$DEMO_NS" -o jsonpath='{.spec.host}')  (user $ASSISTANT_USER, password in $SECRETS_DIR/assistant.env)"
