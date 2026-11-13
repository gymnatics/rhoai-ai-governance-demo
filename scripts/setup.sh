#!/usr/bin/env bash
# One-shot setup of the AI governance demo on an OpenShift AI 3.5 cluster.
# Prerequisites (checked): RHOAI 3.5 with MaaS (gateway maas-default-gateway), TrustyAI (NeMo Guardrails), MLflow, llm-d,
# user-workload monitoring with user alert routing, Keycloak (RHBK) as the OpenShift IdP, >=1 free NVIDIA GPU.
# Every cluster-wide setting we change is recorded in .state/ so scripts/teardown.sh can restore it.
#
# Usage: scripts/setup.sh [--gpu-nodes N] [--with-loki] [--with-workbench] [--no-wait] [--skip-users]
source "$(dirname "$0")/lib.sh"
GPU_NODES=""; WITH_LOKI=false; WITH_WB=false; WAIT=true; USERS=true
while [ $# -gt 0 ]; do case "$1" in
  --gpu-nodes) GPU_NODES=$2; shift 2;; --with-loki) WITH_LOKI=true; shift;; --with-workbench) WITH_WB=true; shift;;
  --no-wait) WAIT=false; shift;; --skip-users) USERS=false; shift;; -h|--help) sed -n '2,8p' "$0"; exit 0;;
  *) die "unknown option $1";; esac; done
S="$STATE_DIR/setup-state.env"; touch "$S"
remember() { grep -q "^$1=" "$S" 2>/dev/null || echo "$1='$2'" >> "$S"; }   # first value wins (= original)

log "preflight on $API_URL"
oc get datasciencecluster -o name >/dev/null 2>&1 || die "OpenShift AI (DataScienceCluster) not found"
oc get gateway maas-default-gateway -n openshift-ingress >/dev/null 2>&1 || die "MaaS gateway maas-default-gateway not found"
oc get crd nemoguardrails.trustyai.opendatahub.io >/dev/null 2>&1 || die "TrustyAI NeMo Guardrails CRD not found (DSC trustyai: Managed)"
oc get crd maassubscriptions.maas.opendatahub.io >/dev/null 2>&1 || die "MaaS CRDs not found"
[ -n "$LLM_TEMPLATE" ] || die "no llm-d single-node NVIDIA template found (LLMInferenceServiceConfig *-single-node-template-nvidia-cuda)"
oc get maastenantconfig default-tenant -n "$MAAS_NS" >/dev/null 2>&1 || die "MaasTenantConfig default-tenant not found in $MAAS_NS"
ok "RHOAI, MaaS, TrustyAI present · template $LLM_TEMPLATE · MaaS $MAAS_URL · dashboard $DASH_URL"

if [ -n "$GPU_NODES" ]; then
  MS=${GPU_MACHINESET:-$(oc get machineset -n openshift-machine-api -o name | grep -i gpu | head -1 | cut -d/ -f2)}
  [ -n "$MS" ] || die "no GPU MachineSet found; set GPU_MACHINESET"
  remember GPU_MACHINESET "$MS"; remember GPU_REPLICAS "$(oc get machineset "$MS" -n openshift-machine-api -o jsonpath='{.spec.replicas}')"
  oc scale machineset "$MS" -n openshift-machine-api --replicas="$GPU_NODES" >/dev/null && ok "GPU MachineSet $MS -> $GPU_NODES (nodes take ~10-15 min)"
fi

log "MaaS telemetry (subscription/user labels on token metrics)"
remember TELEMETRY "$(oc get maastenantconfig default-tenant -n "$MAAS_NS" -o jsonpath='{.spec.telemetry}')"
oc patch maastenantconfig default-tenant -n "$MAAS_NS" --type merge -p '{"spec":{"telemetry":{"enabled":true,"metrics":{"captureOrganization":true,"captureUser":true,"captureGroup":false,"captureModelUsage":true}}}}' >/dev/null
ok "telemetry enabled"

log "dashboard flags (observabilityDashboard, externalModels, guardrails: Technology Preview)"
for f in observabilityDashboard externalModels guardrails; do
  remember "FLAG_$f" "$(oc get odhdashboardconfig odh-dashboard-config -n redhat-ods-applications -o jsonpath="{.spec.dashboardConfig.$f}")"; done
oc patch odhdashboardconfig odh-dashboard-config -n redhat-ods-applications --type merge -p '{"spec":{"dashboardConfig":{"observabilityDashboard":true,"externalModels":true,"guardrails":true}}}' >/dev/null
ok "flags set"

log "namespaces + MaaS gateway-access labels"
oc get ns "$MODEL_NS" >/dev/null 2>&1 || { oc create ns "$MODEL_NS" >/dev/null; remember CREATED_MODEL_NS "$MODEL_NS"; }
for ns in "$MODEL_NS" "$MAAS_NS" redhat-ods-applications; do
  cur=$(oc get ns "$ns" -o jsonpath='{.metadata.labels.maas\.opendatahub\.io/gateway-access}')
  [ "$cur" = true ] || { remember "LABELLED_$(echo "$ns" | tr 'a-z-' 'A-Z_')" "$ns"; oc label ns "$ns" maas.opendatahub.io/gateway-access=true --overwrite >/dev/null; }
done
ok "labels ok"

if $USERS; then log "users + groups (Keycloak)"; bash "$REPO_DIR/scripts/create-users.sh"; fi

log "models (aigov-qwen3-8b on GPU, aigov-small on CPU)"
apply_manifest "$REPO_DIR/manifests/01-model.yaml" >/dev/null
if $WAIT; then
  for i in $(seq 1 120); do
    r=$(oc get llminferenceservice aigov-qwen3-8b -n "$MODEL_NS" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}')
    [ "$r" = True ] && break; sleep 10; done
  [ "$r" = True ] && ok "aigov-qwen3-8b Ready" || warn "aigov-qwen3-8b not Ready after 20 min (GPU? image pull?) - continuing"
fi

log "MaaS subscriptions + auth policies, API keys"
apply_manifest "$REPO_DIR/manifests/02-maas-per-app.yaml" >/dev/null
for i in $(seq 1 30); do [ "$(oc get maassubscription aigov-chatbot -n "$MAAS_NS" -o jsonpath='{.status.phase}')" = Active ] && break; sleep 2; done
bash "$REPO_DIR/scripts/mint-api-keys.sh"

log "guardrails (NeMo Guardrails, TrustyAI)"
apply_manifest "$REPO_DIR/manifests/10-namespace.yaml" >/dev/null
python3 -I "$REPO_DIR/scripts/render-nemo-configs.py" >/dev/null
apply_manifest "$STATE_DIR/12-nemo-configs.rendered.yaml" >/dev/null
bash "$REPO_DIR/scripts/create-nemo-secrets.sh"
apply_manifest "$REPO_DIR/manifests/13-nemo-cr.yaml" >/dev/null
apply_manifest "$REPO_DIR/manifests/14-app-rbac.yaml" >/dev/null
for i in $(seq 1 60); do oc get pods -n "$DEMO_NS" --no-headers 2>/dev/null | grep -q 'aigov-guardrails.*2/2.*Running' && break; sleep 5; done
ok "guardrail server: $NEMO_URL"

log "audit RBAC, budget alerts, alert inbox"
for m in 15-audit-rbac 20-budget-alert 21-alert-receiver; do apply_manifest "$REPO_DIR/manifests/$m.yaml" >/dev/null; done
ok "alert inbox: $RECEIVER_URL"

if $WITH_LOKI; then
  log "Loki (MaaS per-request usage records, Technology Preview)"
  oc get csv -A 2>/dev/null | grep -q loki-operator || { apply_manifest "$REPO_DIR/manifests/30-loki-operator.yaml" >/dev/null; remember INSTALLED_LOKI_OPERATOR yes; }
  for i in $(seq 1 60); do oc get crd lokistacks.loki.grafana.com >/dev/null 2>&1 && break; sleep 5; done
  bash "$REPO_DIR/scripts/create-loki-storage.sh"
  oc get lokistack usage -n "$MONITORING_NS" >/dev/null 2>&1 || { apply_manifest "$REPO_DIR/manifests/31-lokistack-usage.yaml" >/dev/null; remember CREATED_LOKISTACK yes; }
  ok "LokiStack usage applied"
fi

if $WITH_WB; then log "workbench"; bash "$REPO_DIR/scripts/create-workbench.sh"; fi

bash "$REPO_DIR/scripts/a1-reset.sh"
bash "$REPO_DIR/scripts/render-runthrough.sh"
log "verify"
bash "$REPO_DIR/scripts/verify.sh" || warn "verify reported failures (token metrics appear after the first traffic)"
ok "setup complete. Run-through: $REPO_DIR/RUN-THROUGH.local.html · terminal: eval \"\$(scripts/env.sh)\" · state: $S"
