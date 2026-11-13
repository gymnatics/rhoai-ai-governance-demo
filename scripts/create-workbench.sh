#!/usr/bin/env bash
# Create the demo workbench aigov-workbench (JupyterLab, standard data-science image) with the demo env injected,
# and copy notebooks/ + data/ into it (~/aigov). Uses the rhoai-toolkit workbench helper (TOOLKIT_DIR).
source "$(dirname "$0")/lib.sh"; load_secrets
: "${TOOLKIT_DIR:?set TOOLKIT_DIR to your rhoai-toolkit checkout (the toolkit launcher sets it)}"
WB=aigov-workbench
apply_manifest "$REPO_DIR/manifests/16-workbench-identities.yaml" >/dev/null
for s in aigov-app-token aigov-finops-token; do
  for i in $(seq 1 20); do [ -n "$(oc get secret $s -n "$DEMO_NS" -o jsonpath='{.data.token}' 2>/dev/null)" ] && break; sleep 2; done
done
APP_TOKEN=$(oc get secret aigov-app-token -n "$DEMO_NS" -o jsonpath='{.data.token}' | base64 -d)
FINOPS_TOKEN=$(oc get secret aigov-finops-token -n "$DEMO_NS" -o jsonpath='{.data.token}' | base64 -d)
PROM_URL=https://$(oc get route thanos-querier -n openshift-monitoring -o jsonpath='{.spec.host}')
oc create secret generic aigov-demo-env -n "$DEMO_NS" \
  --from-literal=NEMO_URL="$NEMO_URL" --from-literal=NEMO_TOKEN="$APP_TOKEN" --from-literal=NEMO_MODEL="$MODEL_ID" \
  --from-literal=MAAS_URL="$MAAS_URL" --from-literal=MODEL_ID="$MODEL_ID" --from-literal=SMALL_MODEL_ID="$SMALL_MODEL_ID" \
  --from-literal=KEY_CHATBOT="$APP_CHATBOT_KEY" --from-literal=KEY_IDOCR="$APP_IDOCR_KEY" \
  --from-literal=KEY_COLLECTIONS="$APP_COLLECTIONS_KEY" --from-literal=KEY_MARKETING="$APP_MARKETING_KEY" \
  --from-literal=JUDGE_KEY="$APP_IDOCR_KEY" --from-literal=LEAK_KEY="$APP_IDOCR_KEY" \
  --from-literal=PROM_URL="$PROM_URL" --from-literal=PROM_TOKEN="$FINOPS_TOKEN" --from-literal=RECEIVER_URL="$RECEIVER_URL" \
  --from-literal=MLFLOW_TRACKING_URI="$DASH_URL/mlflow" --from-literal=MLFLOW_TRACKING_TOKEN="$APP_TOKEN" --from-literal=MLFLOW_WORKSPACE="$DEMO_NS" \
  --dry-run=client -o yaml | oc apply -f - >/dev/null
oc label secret aigov-demo-env -n "$DEMO_NS" app.kubernetes.io/part-of="$PART_OF" --overwrite >/dev/null
ok "secret aigov-demo-env"

source "$TOOLKIT_DIR/lib/utils/colors.sh" 2>/dev/null || true
source "$TOOLKIT_DIR/lib/utils/common.sh" 2>/dev/null || true
source "$TOOLKIT_DIR/lib/functions/workbench.sh"
ensure_workbench "$DEMO_NS" "$WB" "" 1 2 4Gi 8Gi 0 20Gi "AI governance demo"
if ! oc get notebook $WB -n "$DEMO_NS" -o jsonpath='{.spec.template.spec.containers[0].envFrom}' | grep -q aigov-demo-env; then
  oc patch notebook $WB -n "$DEMO_NS" --type=json -p '[{"op":"add","path":"/spec/template/spec/containers/0/envFrom","value":[{"secretRef":{"name":"aigov-demo-env"}}]}]' >/dev/null
  oc delete pod ${WB}-0 -n "$DEMO_NS" --ignore-not-found >/dev/null
fi
wait_for_workbench "$DEMO_NS" "$WB" 300
oc exec -n "$DEMO_NS" ${WB}-0 -c $WB -- mkdir -p /opt/app-root/src/aigov
for d in notebooks data; do oc cp "$REPO_DIR/$d" "$DEMO_NS/${WB}-0:/opt/app-root/src/aigov/" -c $WB; done
ok "workbench $WB: $DASH_URL/notebook/$DEMO_NS/$WB  (folder ~/aigov)"
