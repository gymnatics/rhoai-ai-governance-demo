#!/usr/bin/env bash
# Mint one sk-oai- MaaS API key per demo app (self-service path: the app user's own token -> maas-api).
# Writes .secrets/api-keys.env with APP_<APP>_KEY variables. aigov-app-unauth has no subscription, so it cannot get a key (expected).
source "$(dirname "$0")/lib.sh"
OUT="$SECRETS_DIR/api-keys.env"; touch "$OUT"; chmod 600 "$OUT"
mint() { # user subscription varname
  local tok key; tok=$(user_token "$1")
  key=$(curl -sk -X POST -H "Authorization: Bearer $tok" -H 'Content-Type: application/json' "$MAAS_URL/maas-api/v1/api-keys" \
        -d "{\"name\":\"$1-demo\",\"expiresIn\":\"720h\",\"subscription\":\"$2\"}" | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("key",""))
except Exception: print("")')
  [ -n "$key" ] || { warn "$1: no key (subscription $2)"; return 0; }
  grep -v "^$3=" "$OUT" > "$OUT.tmp" || true; echo "$3=$key" >> "$OUT.tmp"; mv "$OUT.tmp" "$OUT"; chmod 600 "$OUT"; ok "$3 minted"
}
mint aigov-app-chatbot     aigov-chatbot     APP_CHATBOT_KEY
mint aigov-app-idocr       aigov-idocr       APP_IDOCR_KEY
mint aigov-app-collections aigov-collections APP_COLLECTIONS_KEY
mint aigov-app-marketing   aigov-marketing   APP_MARKETING_KEY
resp=$(curl -sk -X POST -H "Authorization: Bearer $(user_token aigov-app-unauth)" -H 'Content-Type: application/json' \
  "$MAAS_URL/maas-api/v1/api-keys" -d '{"name":"unauth-demo","expiresIn":"24h"}')
echo "$resp" | grep -q invalid_subscription && ok "aigov-app-unauth refused a key (invalid_subscription), as designed" || warn "unexpected: $resp"
