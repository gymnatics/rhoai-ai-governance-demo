#!/usr/bin/env bash
# Print export statements for the demo settings + API keys, for use in an interactive terminal:
#   eval "$(scripts/env.sh)"
# (scripts/lib.sh itself uses `set -euo pipefail`, which you don't want in an interactive shell.)
source "$(dirname "$0")/lib.sh"; load_secrets
PROM_URL=https://$(oc get route thanos-querier -n openshift-monitoring -o jsonpath='{.spec.host}' 2>/dev/null)
for v in DEMO_NS MODEL_NS MAAS_NS MONITORING_NS API_URL CLUSTER_DOMAIN CONSOLE_URL MAAS_URL DASH_URL NEMO_URL RECEIVER_URL KEYCLOAK_URL \
         MODEL_ID SMALL_MODEL_ID PROM_URL REPO_DIR SECRETS_DIR; do printf 'export %s=%q\n' "$v" "${!v}"; done
for v in $(compgen -v | grep -E '^(APP_[A-Z0-9_]+_KEY|AIGOV_[A-Z0-9_]+_PASSWORD)$'); do printf 'export %s=%q\n' "$v" "${!v}"; done
echo 'cd "$REPO_DIR"'
