#!/usr/bin/env bash
# Build and deploy the AI audit portal (Streamlit sample app, read-only MLflow view) into $DEMO_NS.
# Usage: scripts/deploy-audit-portal.sh [--no-build]
# Login: user "auditor", password in .secrets/audit-portal.env (generated on first run).
source "$(dirname "$0")/lib.sh"
BUILD=true; [ "${1:-}" = "--no-build" ] && BUILD=false
mkdir -p "$SECRETS_DIR"; chmod 700 "$SECRETS_DIR"
[ -f "$SECRETS_DIR/audit-portal.env" ] || (umask 077; printf 'PORTAL_USER=auditor\nPORTAL_PASSWORD=%s\n' "$(openssl rand -hex 8)" > "$SECRETS_DIR/audit-portal.env")
set -a; source "$SECRETS_DIR/audit-portal.env"; set +a

log "manifests"
apply_manifest "$REPO_DIR/manifests/41-audit-portal.yaml" >/dev/null
oc create secret generic aigov-audit-portal-env -n "$DEMO_NS" \
  --from-literal=MLFLOW_TRACKING_URI="$DASH_URL/mlflow" --from-literal=DASH_URL="$DASH_URL" \
  --from-literal=PORTAL_USER="$PORTAL_USER" --from-literal=PORTAL_PASSWORD="$PORTAL_PASSWORD" \
  --dry-run=client -o yaml | oc apply -f - >/dev/null
oc label secret aigov-audit-portal-env -n "$DEMO_NS" app.kubernetes.io/part-of="$PART_OF" --overwrite >/dev/null

if $BUILD; then
  log "build (in-cluster, ~3 min)"
  CTX=$(mktemp -d); trap 'rm -rf "$CTX"' EXIT
  cp "$REPO_DIR"/portal/{portal.py,requirements.txt,Containerfile} "$CTX/"
  oc start-build aigov-audit-portal -n "$DEMO_NS" --from-dir="$CTX" --follow --wait >/dev/null || die "build failed: oc logs -n $DEMO_NS bc/aigov-audit-portal"
fi
oc rollout restart deploy/aigov-audit-portal -n "$DEMO_NS" >/dev/null
oc rollout status deploy/aigov-audit-portal -n "$DEMO_NS" --timeout=300s >/dev/null || die "portal not ready: oc logs -n $DEMO_NS deploy/aigov-audit-portal"
ok "audit portal: https://$(oc get route aigov-audit-portal -n "$DEMO_NS" -o jsonpath='{.spec.host}')  (user $PORTAL_USER, password in $SECRETS_DIR/audit-portal.env)"
