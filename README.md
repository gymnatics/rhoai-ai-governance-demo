# AI governance demo for Red Hat OpenShift AI 3.5

A repeatable, scripted demo of governed LLM access and AI safety on OpenShift AI, built around a fictional bank ("Acme Bank") with four application teams. It covers model deployment from the catalog, self-service API keys, per-app access control, quotas, chargeback, budget alerts, PII guardrails (with an Indonesian identifier pack), prompt-injection defence, output-leak protection and an auditor-grade trail, plus live demo runbooks and UI recording scripts.

Everything is created under the `aigov-*` / `ai-governance-demo` names, and `scripts/teardown.sh` removes it again and restores every cluster-wide setting it changed.

## What it shows

| ID | Scenario | How | Tier (RHOAI 3.5) |
|---|---|---|---|
| A1 | Deploy an open-source model from the catalog, timed | Dashboard deploy wizard, validated Qwen3-8B FP8 | GA (classic path) · Gen AI wizard TP |
| B1 | Self-service model access | Gen AI studio → API keys / Subscriptions | GA |
| B4 | Access control per application | MaaSAuthPolicy + subscriptions, Keycloak identities | GA |
| B5 | Quotas / rate limits, changed live | MaaS token limits (Kuadrant/Limitador) | GA |
| B6 | Token visibility and chargeback per team | Gateway token metrics × price table → CSV | GA metrics · usage dashboard TP |
| B7 | Budget with alert at 80% and cut-off at 100% | MaaS token limit + OpenShift user-defined alerting | GA parts, assembled |
| C1 | Create a PII guardrail from scratch | NeMo Guardrails via console Import YAML | GA |
| C2 | Detect Indonesian PII (English prompts) | Custom guardrail action (NIK, NPWP, account, +62, DOB, mother's maiden name) + Presidio names | GA + custom config |
| C4 | Mask PII before the model | Guardrail masking (`/v1/checks`) | GA |
| C6 | Block PII leaks in model output | Output rails | GA |
| C7 | Different policy per application | Multiple guardrail configs selected per request | GA |
| D1 | Direct prompt injection (English) | `self check input` with the documented prompt | GA |
| F1 | End-to-end audit trail, auditor read-only | MLflow traces (masked) + NeMo OTel + MaaS Loki usage logs | GA parts · Loki TP |

Reference results from a validation run are in `docs/RUNBOOK.md` (e.g. C2 held-out recall 37/37, D1 48/50 blocked with 0/10 benign blocked, B6 0.000% difference).

## Prerequisites

- OpenShift 4.20+ with **OpenShift AI 3.5**: DataScienceCluster with KServe/llm-d, **Models-as-a-Service** (gateway `maas-default-gateway`, MaaS tenant), **TrustyAI** (NeMo Guardrails), **MLflow**, dashboard
- **Red Hat Connectivity Link** (Kuadrant/Authorino/Limitador), as required by MaaS
- User-workload monitoring with user alert routing (`enableUserAlertmanagerConfig: true`)
- **Red Hat build of Keycloak** as the OpenShift identity provider (the demo creates its app and auditor users there)
- At least **one free NVIDIA GPU** (L40S/A10G/L4-class; FP8 needs compute capability 8+)
- Optional: Loki Operator + S3 storage (F1 per-request usage logs); the rhoai-toolkit for the workbench
- Workstation: `oc`, `python3`, `envsubst`, `curl`, `openssl`; Node 20+ only for recordings

The rhoai-toolkit installs all of the above; its `demo/ai-governance-demo/deploy.sh` clones this repo and runs the setup for you.

## Quick start

```bash
oc login https://api.<cluster>:6443 -u <cluster-admin>
cp config/demo.env.example config/demo.env      # optional overrides
scripts/setup.sh --with-workbench               # add --gpu-nodes N to scale a GPU MachineSet, --with-loki for F1 usage logs
scripts/verify.sh                               # all PASS before every session
open RUN-THROUGH.local.html                     # interactive run sheet with your cluster's URLs
eval "$(scripts/env.sh)"                        # terminal: URLs, model IDs, demo API keys
```

Teardown (asks for confirmation; restores telemetry, dashboard flags, gateway labels and GPU replicas from `.state/`):

```bash
scripts/teardown.sh            # --keep-users to keep the Keycloak users, --purge-local to delete .secrets/
```

## Repo layout

| Path | Contents |
|---|---|
| `manifests/` | Templates (rendered with an explicit `envsubst` variable list): models, MaaS policies, guardrails, RBAC, alerts, alert inbox, Loki |
| `scripts/` | `setup.sh`, `teardown.sh`, `verify.sh`, `lib.sh` (detection + helpers), `env.sh`, user/key/secret helpers, demo helpers (`a1-reset.sh`, `b5-set-limit.sh`, `b7-new-budget.sh`) |
| `notebooks/` | Evaluation harness + 9 demo notebooks (C2, C4, C6, C7, D1, B5, B6, B7, F1) |
| `data/` | Synthetic datasets (PII, prompt injection, masking usefulness) and their generators. All values are synthetic |
| `docs/` | `RUN-THROUGH.html` (interactive run sheet), `DEMO-RUN-WORKFLOW.md`, `RUNBOOK.md` (results, J7 tier table), `C1-create-guardrail.md` |
| `recordings/` | Playwright scripts that record 1080p fallback videos with captions, stopwatch and fast-forward (`recordings/run.sh <script>.mjs`) |

Generated and never committed: `.secrets/` (passwords, API keys, per-user kubeconfigs), `.state/` (original values for teardown), `reports/`, `recordings/out/`, `RUN-THROUGH.local.html`.

## Recording fallback videos

```bash
cd recordings && npm install && npx playwright install chromium && cd ..
export ADMIN_PASSWORD=...              # cluster admin user (Keycloak)
recordings/run.sh a1-deploy-from-catalog.mjs   # run scripts/a1-reset.sh first
recordings/run.sh b1-b4-self-service-access.mjs
recordings/run.sh c1-create-guardrail.mjs      # project aigov-c1-live must not exist
recordings/run.sh f1-audit-trail.mjs           # after notebooks/F1-audit-trail.ipynb has written traces
recordings/run.sh b6-chargeback.mjs           # after notebooks/B6-chargeback.ipynb; B6_START="YYYY-MM-DD hh:mm:ss" sets the dashboard range
scripts/b7-new-budget.sh rec1 && eval "$(scripts/env.sh)" \
  && B7_SUBSCRIPTION=aigov-collections-budget-rec1 KEY_COLLECTIONS=$APP_COLLECTIONS_BUDGET_REC1_KEY recordings/run.sh b7-budget-alert.mjs
```

Each video goes to `recordings/out/`, and stretches where the page is still blank white while it loads are cut automatically (`recordings/trim-blank.py`; set `NO_TRIM=1` to keep them).

## Data

Every name, ID number, phone number, account number and email address in `data/`, `notebooks/` and `docs/` is synthetic. Email addresses use the reserved `example.com`, `example.net` and `example.org` domains.

## License

Apache License 2.0. See [LICENSE](LICENSE).
