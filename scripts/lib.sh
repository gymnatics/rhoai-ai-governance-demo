#!/usr/bin/env bash
# Shared settings + helpers for the AI governance demo. Source it: source "$(dirname "$0")/lib.sh"
# Everything cluster-specific is DETECTED from the current `oc` login (or overridden in config/demo.env).
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -f "$REPO_DIR/config/demo.env" ] && set -a && source "$REPO_DIR/config/demo.env" && set +a

: "${DEMO_NS:=ai-governance-demo}"          # guardrails, workbench, alert receiver, audit
: "${MODEL_NS:=llm}"                         # where the demo models are served (needs the MaaS gateway-access label)
: "${MAAS_NS:=models-as-a-service}"          # MaaS tenant namespace (subscriptions, auth policies)
: "${MONITORING_NS:=redhat-ods-monitoring}"  # DSCI monitoring namespace (OTel collector, LokiStack)
: "${PART_OF:=ai-governance-demo}"           # label app.kubernetes.io/part-of on everything we create
: "${BRAND:=Acme Bank}"
SECRETS_DIR="$REPO_DIR/.secrets"; STATE_DIR="$REPO_DIR/.state"
mkdir -p "$SECRETS_DIR/kube" "$STATE_DIR"; chmod 700 "$SECRETS_DIR" "$SECRETS_DIR/kube" "$STATE_DIR"

log()  { printf '\033[1;34m▶ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

oc whoami >/dev/null 2>&1 || die "not logged in: run 'oc login' (or export KUBECONFIG) first"

: "${API_URL:=$(oc whoami --show-server)}"
: "${CLUSTER_DOMAIN:=$(oc get ingresses.config cluster -o jsonpath='{.spec.domain}')}"
: "${CONSOLE_URL:=$(oc whoami --show-console 2>/dev/null || echo "https://console-openshift-console.${CLUSTER_DOMAIN}")}"
if [ -z "${MAAS_URL:-}" ]; then
  h=$(oc get gateway maas-default-gateway -n openshift-ingress -o jsonpath='{.spec.listeners[0].hostname}' 2>/dev/null || true)
  MAAS_URL="https://${h:-maas.${CLUSTER_DOMAIN}}"
fi
if [ -z "${DASH_URL:-}" ]; then
  h=$(oc get gateway data-science-gateway -n openshift-ingress -o jsonpath='{.spec.listeners[0].hostname}' 2>/dev/null || true)
  [ -z "$h" ] && h=$(oc get route -A -o jsonpath='{range .items[?(@.spec.to.name=="rhods-dashboard")]}{.spec.host}{"\n"}{end}' 2>/dev/null | head -1)
  DASH_URL="https://${h:-rh-ai.${CLUSTER_DOMAIN}}"
fi
: "${NEMO_URL:=https://aigov-guardrails-${DEMO_NS}.${CLUSTER_DOMAIN}}"
: "${RECEIVER_URL:=https://aigov-alert-receiver-${DEMO_NS}.${CLUSTER_DOMAIN}}"
: "${KEYCLOAK_URL:=$(oc get route -n keycloak -o jsonpath='{.items[0].spec.host}' 2>/dev/null | sed 's|^|https://|' || true)}"
if [ -z "${LLM_TEMPLATE:-}" ]; then   # newest RHOAI llm-d single-node NVIDIA template (e.g. v3-5-2-kserve-config-llm-single-node-template-nvidia-cuda)
  LLM_TEMPLATE=$(oc get llminferenceserviceconfig -n redhat-ods-applications -o name 2>/dev/null \
    | sed 's|.*/||' | grep -E 'single-node-template-nvidia-cuda$' | sort -V | tail -1 || true)
fi
: "${MODEL_URI:=oci://registry.redhat.io/rhelai1/modelcar-qwen3-8b-fp8-dynamic:1.5}"
: "${MODEL_SERVED_NAME:=RedHatAI/Qwen3-8B-FP8-dynamic}"
MODEL_ID="publishers/${MODEL_NS}/models/${MODEL_SERVED_NAME}"
SMALL_MODEL_ID="publishers/${MODEL_NS}/models/facebook/opt-125m"
export DEMO_NS MODEL_NS MAAS_NS MONITORING_NS PART_OF BRAND API_URL CLUSTER_DOMAIN CONSOLE_URL MAAS_URL DASH_URL \
       NEMO_URL RECEIVER_URL KEYCLOAK_URL LLM_TEMPLATE MODEL_URI MODEL_SERVED_NAME MODEL_ID SMALL_MODEL_ID SECRETS_DIR STATE_DIR REPO_DIR

# Variables substituted into manifests (explicit list: Colang/YAML `$user_message` etc. must stay untouched)
RENDER_VARS='${DEMO_NS} ${MODEL_NS} ${MAAS_NS} ${MONITORING_NS} ${PART_OF} ${BRAND} ${MAAS_URL} ${CLUSTER_DOMAIN} ${LLM_TEMPLATE} ${MODEL_URI} ${MODEL_SERVED_NAME} ${MODEL_ID} ${SMALL_MODEL_ID}'
render() { envsubst "$RENDER_VARS" < "$1"; }                 # render <manifest>  -> stdout
apply_manifest() { render "$1" | oc apply -f - ; }            # apply_manifest <manifest>

load_secrets() { [ -f "$SECRETS_DIR/api-keys.env" ] && { set -a; source "$SECRETS_DIR/api-keys.env"; set +a; }; [ -f "$SECRETS_DIR/app-users.env" ] && { set -a; source "$SECRETS_DIR/app-users.env"; set +a; }; return 0; }
user_token() { KUBECONFIG="$SECRETS_DIR/kube/$1" oc whoami -t; }   # token of a demo app user (after create-users.sh)
APP_USERS="aigov-app-chatbot aigov-app-idocr aigov-app-collections aigov-app-marketing aigov-app-unauth aigov-auditor1"
