# C1: Create a new PII guardrail from scratch (live)

**What the audience sees:** a security analyst creates a PII policy without writing code. They edit a template (entity list, plus one regex line for a bank-specific pattern), apply it in the OpenShift console, and the guardrail starts blocking PII in front of the model.
**Tier:** NeMo Guardrails, GA in RHOAI 3.5 (x86_64). Built-in flows `detect sensitive data on input` (Presidio) and `regex check input` follow the documented quick start (Enabling AI safety with Guardrails, 3.5, §1.1 and §1.5).
**How it's created:** configuration (YAML template in the console). There is no policy UI in 3.5 GA; guardrails in the playground are TP.
**Time target:** ≤ 5 min from an empty project to the first blocked request.

## Steps (console: Administrator → Import YAML, project `aigov-c1-live`)

1. Create the project: Home → Projects → Create project → `aigov-c1-live`.
2. Import YAML, paste the template below. The analyst **edits only two places**:
   - `entities:` (pick from the list: PERSON, EMAIL_ADDRESS, PHONE_NUMBER, CREDIT_CARD, IBAN_CODE, LOCATION ...)
   - `patterns:` adds a bank-specific pattern, e.g. a customer number `CIF-\d{8}` or NIK `\b\d{16}\b`
3. Create. Wait for the pod to show Ready (≈1 min).
4. Test (terminal or notebook): see "Test" below. Expect `blocked` for a prompt with an e-mail or CIF number and `success` for a clean prompt.
5. Live change (C3 preview): add another pattern in the ConfigMap, save, restart the pod, and re-test. Time it.

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: c1-pii-policy
  namespace: aigov-c1-live
data:
  config.yaml: |
    rails:
      config:
        sensitive_data_detection:
          input:
            entities:            # <-- analyst edits: which PII types to block
              - PERSON
              - EMAIL_ADDRESS
              - PHONE_NUMBER
        regex_detection:
          input:
            patterns:            # <-- analyst edits: bank-specific patterns (double backslashes)
              - "\\bCIF-\\d{8}\\b"
              - "\\b\\d{16}\\b"
            case_insensitive: true
      input:
        flows:
          - detect sensitive data on input
          - regex check input
  rails.co: |
    # built-in rails only
---
apiVersion: trustyai.opendatahub.io/v1alpha1
kind: NemoGuardrails
metadata:
  name: c1-guardrail
  namespace: aigov-c1-live
  annotations:
    security.opendatahub.io/enable-auth: "true"
spec:
  nemoConfigs:
    - name: c1-pii-policy
      configMaps: [c1-pii-policy]
```

## Test

```bash
eval "$(scripts/env.sh)"   # or: oc login ... first
R=https://$(oc get route c1-guardrail -n aigov-c1-live -o jsonpath='{.spec.host}')
T=$(oc whoami -t)
for p in "Please email the statement to budi.santoso@example.com" "My customer number is CIF-12345678" "What are your branch opening hours?"; do
  curl -sk -X POST $R/v1/guardrail/checks -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
    -d "{\"model\":\"x\",\"messages\":[{\"role\":\"user\",\"content\":\"$p\"}]}" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["status"], d.get("rails_status"))'
done
```

## Notes
- **Attach to a model:** add a `models:` block (main model = MaaS endpoint plus an API key Secret via `spec.env`) to also use `/v1/chat/completions`. The production Acme Bank configuration (`aigov-guardrails`) already does this, with masking and Indonesian identifiers.
- **Gotchas found in the PoC:** `enable-auth` must be set at creation; keep all files in **one** ConfigMap per config (multiple ConfigMaps fail on 3.5.2); `oc get nemoguardrails` may resolve to the NVIDIA CRD, so use `nemoguardrails.trustyai.opendatahub.io`.
- **Cleanup:** `oc delete project aigov-c1-live`.
