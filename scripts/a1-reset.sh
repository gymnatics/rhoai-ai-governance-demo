#!/usr/bin/env bash
# Reset project aigov-a1-live between A1 rehearsals (creates it if missing).
# Besides the LLMInferenceService, the dashboard deploy wizard creates a per-deployment LLMInferenceServiceConfig and a
# token ServiceAccount; this script removes all of them so the next deploy starts clean.
source "$(dirname "$0")/lib.sh"
NS=aigov-a1-live
if ! oc get ns "$NS" >/dev/null 2>&1; then
  oc new-project "$NS" --display-name="AIGOV A1 live deploy" >/dev/null
  oc label ns "$NS" opendatahub.io/dashboard=true app.kubernetes.io/part-of="$PART_OF" --overwrite >/dev/null
fi
oc delete llminferenceservice --all -n "$NS" --wait=true --timeout=180s 2>/dev/null || true
oc delete llminferenceserviceconfig --all -n "$NS" 2>/dev/null || true
for sa in $(oc get sa -n "$NS" -o name | grep -v -E '/(builder|default|deployer|kserve-metrics-reader-sa)$'); do oc delete -n "$NS" "$sa"; done
ok "$NS reset (empty, ready for a live dashboard deploy)"
