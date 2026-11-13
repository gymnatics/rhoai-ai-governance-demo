# AI governance demo: AI-team demo runbook

Validated on RHOAI 3.5.2 · OCP 4.21 · NVIDIA L40S.
Before every session: `scripts/verify.sh` (expect **all PASS**; it checks B4, guardrails, metrics, Loki, MLflow and the shared-cluster guard).

## Demo order (~55 min live, every scenario has a recorded fallback)

| # | Row | Live demo | Measured result | Fallback video |
|---|---|---|---|---|
| 1 | **A1** | Dashboard → AI hub → Models → Catalog → Qwen3-8B-FP8 → Deploy (project `aigov-a1-live`, gpu-profile, vLLM NVIDIA CUDA **v3-5-2** single node, token auth on by default) → curl with generated token. **Run `scripts/a1-reset.sh` first** | Ready **209–220 s**, first response **218–227 s** (3.6–3.8 min, warm image); 401 without token / 200 with | `recordings/out/A1-deploy-from-catalog.mp4` |
| 2 | **B1/B4** | aigov-app-chatbot: Gen AI studio → API keys → Subscriptions → Create API key (masked, copy) → call; revoke. aigov-app-unauth: "No subscriptions available". Admin: Settings → MaaS governance | key in **33 s**, first call **44 s**; own model 200 · other model **403** · forged 403 · no key 401 · revoked key 403 within **0.6 s**; app without subscription **cannot get a key** | `recordings/out/B1-B4-self-service-access.mp4` |
| 3 | **B5** | `scripts/b5-set-limit.sh 3000` → notebook `B5-quota.ipynb` (24 parallel calls) → `scripts/b5-set-limit.sh 100000` | limit change effective in **4–11 s**; 16×200 then 8×429 within 11 s (~25% overshoot: tokens are counted after the response) | (notebook) |
| 4 | **B6** | `B6-chargeback.ipynb` (1,000 calls 500/300/200) | platform vs client **0.000% difference**; CSV per team / cost centre, IDR 0.25/token | `recordings/out/B6-chargeback.mp4`, `reports/chargeback-*.csv` |
| 5 | **B7** | Receiver page + `B7-budget.ipynb` (collections, 20k tokens/h demo budget). Needs ≥1 h since last B7 run | 80% alert at receiver ≈**36 s** after crossing; 429 at 100%; 100% alert ≈**4 s** after cut-off | `recordings/out/B7-budget-alert.mp4` (80% + 100% rows) |
| 6 | **C1** | Console → Create project `aigov-c1-live` → Import YAML (docs/C1-create-guardrail.md) → test. **Delete the project first** | policy live in **38–51 s**; e-mail, CIF number and 16-digit ID blocked, clean prompt passes, 401 without token | `recordings/out/C1-create-guardrail.mp4` |
| 7 | **C2** | `C2-pii-detection.ipynb`: **held-out set first** | held-out **37/37 recall, 2/12 FP**; DS1 (tuning set) 180/180, 0/60 | (notebook) |
| 8 | **C4** | `C4-masking.ipynb`: what the model receives | **41/41** PII values masked; **28/30** answers useful; 0 repeat PII | (notebook) |
| 9 | **C6** | `C6-output-leakage.ipynb` | unguarded model leaked in 13/15; output rails blocked **12/13**; 0/2 clean blocked | (notebook) |
| 10 | **C7 preview** | `C7-policies-per-app.ipynb` | chatbot masks NIK; id-ocr keeps NIK; block / mask / log-only on one server, no redeploy | (notebook) |
| 11 | **D1** | `D1-prompt-injection.ipynb` (EN) | **48/50** attacks blocked (96%); **0/10** benign and 0/20 traps blocked; p50 ~0.9 s | (notebook) |
| 12 | **F1** | Sign in as **aigov-auditor1** → Develop & train → Experiments → aigov-audit → Traces → trace detail (+tags) | every call: request_id, end user, app, API key, subscription, model and version, time, **masked** prompt and response, decision; auditor read 200 / write 403, no pod logs | `recordings/out/F1-audit-trail.mp4` |

Notebooks run in workbench **`aigov-workbench`**: ${DASH_URL}/notebook/ai-governance-demo/aigov-workbench (folder `~/aigov`; env from Secret `aigov-demo-env`). C7, D1, C2 and F1 were executed headless in the workbench on 12 Nov and reproduce the local results (D1 48/50, C2 held-out 37/37 with 2/12 FP, F1 masked traces).

**Videos:** 1920×1080 H.264 (Chrome DevTools screencast, near-lossless frames, real timing). Re-record any with `node recordings/<id>.mjs` (A1 needs `scripts/a1-reset.sh` first, C1 needs `aigov-c1-live` deleted, B7 needs ≥1 h since the last run).

## Resets and gotchas
- **A1:** run `scripts/a1-reset.sh` between rehearsals. It removes the previous deployment and everything the wizard created for it, so the next deploy starts clean.
- **A1 answer shows `<think>`:** a plain dashboard deploy keeps Qwen3 thinking on. Send `chat_template_kwargs: {"enable_thinking": false}` or add the runtime argument in the wizard.
- **B5:** always restore `scripts/b5-set-limit.sh 100000`. The guardrail judge spends the chatbot's tokens.
- **B7:** the demo budget is per hour; wait ≥1 h between runs (both the Limitador window and the alert's 1 h delta must clear).
- **C1:** `oc get nemoguardrails` may hit the NVIDIA CRD; use `nemoguardrails.trustyai.opendatahub.io`.

## J7: feature maturity (AI-team rows)

Tier sources: RHOAI 3.5 release notes (Ch. 2–4), Supported Configurations 3.x, product guides (lastModified 2026-11-06). "Assembled" means built from GA parts plus PoC configuration or scripts.

| Row | Status | Feature(s) used | Tier | Notes |
|---|---|---|---|---|
| A1 | M | Model catalog (validated models), LLMInferenceService (vLLM), hardware profiles, token auth | **GA** | The unified Gen AI deploy wizard is **TP** (3.5 RN §3.1); the classic deploy path and CLI are GA |
| B4 | M | MaaS subscriptions + MaaSAuthPolicy + API keys; OpenShift IdP via Keycloak (RHBK) | **GA** | External OIDC for MaaS is also GA (not used live) |
| B5 | M | MaaS token rate limits (Kuadrant/Limitador) | **GA** | Request-count limits need an extra RateLimitPolicy (not shown) |
| B6 | M | Limitador token metrics with subscription/user/cost_center labels (MaaS telemetry); chargeback CSV by notebook | **GA metrics + assembled report** | MaaS observability dashboard **TP**; docs say showback is "not billing-grade"; external metering **DP** |
| B7 | M | MaaS token limit (cut-off) + OCP user-defined alerting (PrometheusRule, AlertmanagerConfig) | **GA parts, assembled** | No native budget object |
| C1 | M | NeMo Guardrails (TrustyAI `NemoGuardrails` CR), Presidio + regex rails | **GA** (x86_64) | No policy UI in GA; playground guardrails **TP** |
| C2 | M | NeMo + custom Python action (documented GA pattern) for Indonesian identifiers; Presidio names | **GA + custom config** | English only (Bahasa out of scope) |
| C4 | M | Masking via custom action / Presidio | **GA + custom config** | |
| C6 | M | NeMo output rails | **GA + custom config** | |
| C7 | M (deferred) | Multiple NeMo configs selected per request (`config_id`) | **GA** | Preview only |
| D1 | M | NeMo `self check input` (doc prompt §1.7.3) with Qwen3-8B | **GA** | English only; garak red-teaming (not used) is GA per RN / TP per guide |
| F1 | M | MLflow tracing (GA, x86_64) + NeMo OTel (GA) + MaaS Loki showback (**TP**) | **GA parts, assembled** | No single built-in audit view |

Also on the cluster but not used by the AI team: the DP agent dashboard flags (`agentsCatalog`, `agentConfigManagement`, `agentOps`), MCP lifecycle operator (TP, docs require OCP 4.22+; cluster is 4.21).
