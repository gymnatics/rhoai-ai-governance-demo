#!/usr/bin/env bash
# Run a UI recording with the demo settings: recordings/run.sh <script.mjs>
# Needs: npm install (once, in recordings/), npx playwright install chromium (once), ADMIN_PASSWORD exported.
source "$(dirname "$0")/../scripts/lib.sh"; load_secrets
export ADMIN_PASSWORD="${ADMIN_PASSWORD:?export ADMIN_PASSWORD (cluster admin user password) first}"
export APP_CHATBOT_PASSWORD="${AIGOV_APP_CHATBOT_PASSWORD:-}" APP_UNAUTH_PASSWORD="${AIGOV_APP_UNAUTH_PASSWORD:-}" \
       AIGOV_AUDITOR1_PASSWORD AUDITOR_KUBECONFIG="$SECRETS_DIR/kube/aigov-auditor1" \
       APP_CHATBOT_TOKEN="$(user_token aigov-app-chatbot 2>/dev/null || true)"
export PROM_URL=https://$(oc get route thanos-querier -n openshift-monitoring -o jsonpath='{.spec.host}') PROM_TOKEN=$(oc whoami -t)
cd "$(dirname "$0")" && exec node "${1:?script.mjs}"
