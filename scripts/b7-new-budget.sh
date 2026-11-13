#!/usr/bin/env bash
# Create a fresh budget subscription for team "collections" + an API key for it, so B7 can run (live or recorded)
# without waiting for the previous hourly budget window to clear.
# Usage: scripts/b7-new-budget.sh <suffix>      e.g. scripts/b7-new-budget.sh live1
source "$(dirname "$0")/lib.sh"
SUF=${1:?suffix, e.g. live1}
SUB="aigov-collections-budget-$SUF"
VAR="APP_COLLECTIONS_BUDGET_$(echo "$SUF" | tr 'a-z-' 'A-Z_')_KEY"
cat <<EOF | oc apply -f - >/dev/null
apiVersion: maas.opendatahub.io/v1alpha1
kind: MaaSSubscription
metadata: {name: $SUB, namespace: $MAAS_NS, labels: {app.kubernetes.io/part-of: $PART_OF}}
spec:
  owner: {groups: [{name: aigov-collections}]}
  priority: 15
  tokenMetadata: {costCenter: cc-collections, organizationId: acme, labels: {app: collections}}
  modelRefs:
    - {name: aigov-qwen3-8b, namespace: $MODEL_NS, billingRate: {perToken: "0.25"}, tokenRateLimits: [{limit: 20000, window: 1h}]}
EOF
for i in $(seq 1 30); do [ "$(oc get maassubscription "$SUB" -n "$MAAS_NS" -o jsonpath='{.status.phase}')" = Active ] && break; sleep 2; done
K=$(curl -sk -X POST -H "Authorization: Bearer $(user_token aigov-app-collections)" -H 'Content-Type: application/json' \
  "$MAAS_URL/maas-api/v1/api-keys" -d "{\"name\":\"collections-budget-$SUF\",\"expiresIn\":\"720h\",\"subscription\":\"$SUB\"}" \
  | python3 -c 'import json,sys;print(json.load(sys.stdin).get("key",""))')
[ -n "$K" ] || die "key mint failed"
OUT="$SECRETS_DIR/api-keys.env"; grep -v "^$VAR=" "$OUT" > "$OUT.tmp" || true; echo "$VAR=$K" >> "$OUT.tmp"; mv "$OUT.tmp" "$OUT"; chmod 600 "$OUT"
ok "subscription $SUB Active; key stored as $VAR in .secrets/api-keys.env"
echo "export B7_SUBSCRIPTION=$SUB KEY_COLLECTIONS=\$$VAR   # after: set -a; source .secrets/api-keys.env; set +a"
