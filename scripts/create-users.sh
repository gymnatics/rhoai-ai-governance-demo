#!/usr/bin/env bash
# Create the demo identities (apps + auditor) and OpenShift groups.
# Identity provider: Red Hat build of Keycloak (RHBK) used as the OpenShift OAuth IdP (KEYCLOAK_URL auto-detected
# from the route in namespace "keycloak"; realm KEYCLOAK_REALM, default "sso"). Passwords are generated and stored in
# .secrets/app-users.env; existing users get their password reset so the stored one is always valid.
source "$(dirname "$0")/lib.sh"
: "${KEYCLOAK_REALM:=sso}"
[ -n "$KEYCLOAK_URL" ] || die "no Keycloak route found; set KEYCLOAK_URL/KEYCLOAK_REALM in config/demo.env (Keycloak must be the cluster IdP)"
KU=$(oc get secret keycloak-initial-admin -n keycloak -o jsonpath='{.data.username}' | base64 -d)
KP=$(oc get secret keycloak-initial-admin -n keycloak -o jsonpath='{.data.password}' | base64 -d)
TOK=$(curl -sk -d grant_type=password -d client_id=admin-cli --data-urlencode "username=$KU" --data-urlencode "password=$KP" \
  "$KEYCLOAK_URL/realms/master/protocol/openid-connect/token" | python3 -c 'import json,sys;print(json.load(sys.stdin)["access_token"])')
OUT="$SECRETS_DIR/app-users.env"; touch "$OUT"; chmod 600 "$OUT"
kc() { curl -sk -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' "$@"; }

for u in $APP_USERS; do
  var="$(echo "$u" | tr 'a-z-' 'A-Z_')_PASSWORD"
  pw=$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-16)
  id=$(kc "$KEYCLOAK_URL/admin/realms/$KEYCLOAK_REALM/users?username=$u&exact=true" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d[0]["id"] if d else "")')
  if [ -z "$id" ]; then
    kc -X POST "$KEYCLOAK_URL/admin/realms/$KEYCLOAK_REALM/users" -d "{\"username\":\"$u\",\"enabled\":true,\"emailVerified\":true,\"email\":\"$u@example.com\",\"firstName\":\"$u\",\"lastName\":\"demo\",\"credentials\":[{\"type\":\"password\",\"value\":\"$pw\",\"temporary\":false}]}" >/dev/null
  else
    kc -X PUT "$KEYCLOAK_URL/admin/realms/$KEYCLOAK_REALM/users/$id/reset-password" -d "{\"type\":\"password\",\"value\":\"$pw\",\"temporary\":false}" >/dev/null
  fi
  grep -v "^$var=" "$OUT" > "$OUT.tmp" || true; echo "$var='$pw'" >> "$OUT.tmp"; mv "$OUT.tmp" "$OUT"; chmod 600 "$OUT"
  KUBECONFIG="$SECRETS_DIR/kube/$u" oc login "$API_URL" -u "$u" -p "$pw" --insecure-skip-tls-verify=true >/dev/null && ok "user $u ready"
done

declare -A GROUPS_=( [aigov-chatbot]=aigov-app-chatbot [aigov-idocr]=aigov-app-idocr [aigov-collections]=aigov-app-collections
                    [aigov-marketing]=aigov-app-marketing [aigov-unauthorised]=aigov-app-unauth [aigov-auditor]=aigov-auditor1 )
for g in "${!GROUPS_[@]}"; do
  oc get group "$g" >/dev/null 2>&1 || oc adm groups new "$g" >/dev/null
  oc adm groups add-users "$g" "${GROUPS_[$g]}" >/dev/null
  oc label group "$g" app.kubernetes.io/part-of="$PART_OF" --overwrite >/dev/null
done
ok "groups: ${!GROUPS_[*]}"
