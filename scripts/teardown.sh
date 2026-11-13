#!/usr/bin/env bash
# Remove everything the demo created and restore the cluster-wide settings recorded by setup.sh (.state/setup-state.env).
# Usage: scripts/teardown.sh [--yes] [--keep-users] [--purge-local]
source "$(dirname "$0")/lib.sh"
YES=false; KEEP_USERS=false; PURGE=false
for a in "$@"; do case "$a" in --yes) YES=true;; --keep-users) KEEP_USERS=true;; --purge-local) PURGE=true;; *) die "unknown option $a";; esac; done
S="$STATE_DIR/setup-state.env"; [ -f "$S" ] && source "$S"
echo "Cluster: $API_URL"; echo "Will delete: namespaces $DEMO_NS aigov-a1-live aigov-c1-live; aigov-* models in $MODEL_NS; aigov-* MaaS objects; alerts; groups${KEEP_USERS:+}"
$YES || { read -r -p "Proceed? [y/N] " r; [ "$r" = y ] || exit 1; }
load_secrets; set +e

log "revoke demo API keys (MaaS keys outlive namespaces)"
for u in $APP_USERS; do
  [ -f "$SECRETS_DIR/kube/$u" ] || continue; t=$(user_token "$u" 2>/dev/null) || continue
  for id in $(curl -sk -X POST -H "Authorization: Bearer $t" -H 'Content-Type: application/json' "$MAAS_URL/maas-api/v1/api-keys/search" -d '{}' \
              | python3 -c 'import json,sys
try: [print(k["id"]) for k in json.load(sys.stdin).get("data",[]) if k.get("status")=="active"]
except Exception: pass'); do
    curl -sk -o /dev/null -X DELETE -H "Authorization: Bearer $t" "$MAAS_URL/maas-api/v1/api-keys/$id"; done
done

log "delete demo resources"
oc delete ns "$DEMO_NS" aigov-a1-live aigov-c1-live --ignore-not-found --wait=false
oc delete llminferenceservice,maasmodelref -n "$MODEL_NS" -l app.kubernetes.io/part-of="$PART_OF" --ignore-not-found
oc delete maassubscription,maasauthpolicy -n "$MAAS_NS" -l app.kubernetes.io/part-of="$PART_OF" --ignore-not-found
oc delete prometheusrule,alertmanagerconfig -n kuadrant-system -l app.kubernetes.io/part-of="$PART_OF" --ignore-not-found
oc delete clusterrolebinding -l app.kubernetes.io/part-of="$PART_OF" --ignore-not-found
oc delete group -l app.kubernetes.io/part-of="$PART_OF" --ignore-not-found
[ "${CREATED_LOKISTACK:-}" = yes ] && oc delete lokistack usage -n "$MONITORING_NS" --ignore-not-found
oc delete secret loki-usage-s3 -n "$MONITORING_NS" -l app.kubernetes.io/part-of="$PART_OF" --ignore-not-found
if [ "${INSTALLED_LOKI_OPERATOR:-}" = yes ]; then
  oc delete subscription loki-operator -n openshift-operators-redhat --ignore-not-found
  oc delete csv -n openshift-operators-redhat -l operators.coreos.com/loki-operator.openshift-operators-redhat --ignore-not-found
fi
[ -n "${CREATED_MODEL_NS:-}" ] && oc delete ns "$CREATED_MODEL_NS" --ignore-not-found --wait=false

if ! $KEEP_USERS && [ -n "$KEYCLOAK_URL" ]; then
  log "delete demo users (Keycloak + OpenShift)"
  KU=$(oc get secret keycloak-initial-admin -n keycloak -o jsonpath='{.data.username}' | base64 -d)
  KP=$(oc get secret keycloak-initial-admin -n keycloak -o jsonpath='{.data.password}' | base64 -d)
  TOK=$(curl -sk -d grant_type=password -d client_id=admin-cli --data-urlencode "username=$KU" --data-urlencode "password=$KP" \
    "$KEYCLOAK_URL/realms/master/protocol/openid-connect/token" | python3 -c 'import json,sys;print(json.load(sys.stdin)["access_token"])')
  for u in $APP_USERS; do
    id=$(curl -sk -H "Authorization: Bearer $TOK" "$KEYCLOAK_URL/admin/realms/${KEYCLOAK_REALM:-sso}/users?username=$u&exact=true" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d[0]["id"] if d else "")')
    [ -n "$id" ] && curl -sk -o /dev/null -X DELETE -H "Authorization: Bearer $TOK" "$KEYCLOAK_URL/admin/realms/${KEYCLOAK_REALM:-sso}/users/$id"
    oc delete user "$u" --ignore-not-found >/dev/null; oc get identity -o name | grep ":$u$" | xargs -r oc delete >/dev/null
  done
fi

log "restore cluster-wide settings"
if [ -n "${TELEMETRY+x}" ]; then
  if [ -z "$TELEMETRY" ]; then oc patch maastenantconfig default-tenant -n "$MAAS_NS" --type json -p '[{"op":"remove","path":"/spec/telemetry"}]' >/dev/null
  else oc patch maastenantconfig default-tenant -n "$MAAS_NS" --type merge -p "{\"spec\":{\"telemetry\":$TELEMETRY}}" >/dev/null; fi
fi
for f in observabilityDashboard externalModels guardrails; do
  v="FLAG_$f"; [ -n "${!v+x}" ] || continue
  if [ -z "${!v}" ]; then oc patch odhdashboardconfig odh-dashboard-config -n redhat-ods-applications --type json -p "[{\"op\":\"remove\",\"path\":\"/spec/dashboardConfig/$f\"}]" >/dev/null
  else oc patch odhdashboardconfig odh-dashboard-config -n redhat-ods-applications --type merge -p "{\"spec\":{\"dashboardConfig\":{\"$f\":${!v}}}}" >/dev/null; fi
done
for v in $(compgen -v | grep '^LABELLED_'); do oc label ns "${!v}" maas.opendatahub.io/gateway-access- >/dev/null; done
[ -n "${GPU_MACHINESET:-}" ] && oc scale machineset "$GPU_MACHINESET" -n openshift-machine-api --replicas="$GPU_REPLICAS" >/dev/null && ok "GPU MachineSet back to $GPU_REPLICAS"
mv "$S" "$S.restored-$(date +%Y%m%d%H%M%S)" 2>/dev/null
$PURGE && rm -rf "$SECRETS_DIR" && ok "local .secrets removed"
ok "teardown complete"
