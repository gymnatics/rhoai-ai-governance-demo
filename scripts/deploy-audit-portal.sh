#!/usr/bin/env bash
# Build and deploy the AI audit portal (Streamlit sample app, read-only MLflow view) into $DEMO_NS.
# Usage: scripts/deploy-audit-portal.sh [--no-build | --rebuild]   (idempotent: builds/restarts only what changed)
# Login: user "auditor", password in .secrets/audit-portal.env (generated on first run).
source "$(dirname "$0")/lib.sh"
BUILD=true; FORCE=false
for a in "$@"; do case "$a" in --no-build) BUILD=false;; --rebuild) FORCE=true;; *) echo "unknown option $a (use --no-build or --rebuild)" >&2; exit 1;; esac; done
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
  log "image"
  CTX=$(mktemp -d); trap 'rm -rf "$CTX"' EXIT
  cp "$REPO_DIR"/portal/{portal.py,requirements.txt,Containerfile} "$CTX/"
  build_if_changed aigov-audit-portal "$DEMO_NS" "$CTX" $FORCE || die "build failed: oc logs -n $DEMO_NS bc/aigov-audit-portal"
fi
roll_if_config_changed aigov-audit-portal "$DEMO_NS" aigov-audit-portal-env
oc rollout status deploy/aigov-audit-portal -n "$DEMO_NS" --timeout=300s >/dev/null || die "portal not ready: oc logs -n $DEMO_NS deploy/aigov-audit-portal"
ok "audit portal: https://$(oc get route aigov-audit-portal -n "$DEMO_NS" -o jsonpath='{.spec.host}')  (user $PORTAL_USER, password in $SECRETS_DIR/audit-portal.env)"
