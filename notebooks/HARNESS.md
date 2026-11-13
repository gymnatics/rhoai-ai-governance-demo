# harness.py

Importable evaluation harness for a NeMo Guardrails OpenAI-compatible
server. Stdlib only (pandas/matplotlib optional, used only in
`to_dataframe()` / `plot_metric_bar()`).

## Env vars

- `NEMO_URL` — base URL of the guardrails route, no trailing slash
- `NEMO_TOKEN` — bearer token
- `NEMO_VERIFY_TLS` — set to `false` to skip TLS verification
- `NEMO_CONFIG_ID` — optional default guardrails config id

## Functions

`check(text, config_id=None)`, `transform(text, config_id=None)`,
`chat(messages, model, config_id=None, log=True)` — single API calls.
`evaluate(dataset_path, mode="check", config_id=None, label_field="label",
group_field=None, filter=None, errors_as="unsafe_blocked", workers=4)` —
runs a JSONL dataset concurrently. `metrics(results, group_field=None)` —
TP/FN/FP/TN, recall/precision/F1/FPR/accuracy, p50/p95 latency, overall +
per group. `to_markdown(rows)`, `to_csv(rows, path)`.
`masking_coverage(records)` — % of `pii_values` no longer verbatim in
`transform()` output. `explain(result)` — pretty-print raw response.
Adjust `_is_blocked()` / `_extract_text()` once real server responses are seen.

Selftest (no network): `python3 -I notebooks/harness.py selftest`

## Examples

```python
import harness as h

# C2: PII detection, grouped by pii_type
results = h.evaluate("data/ds1_pii_en.jsonl", mode="check", group_field="pii_type")
h.to_markdown(h.metrics(results, group_field="pii_type"))

# D1: prompt injection, grouped by attack_type, scored records only
results = h.evaluate(
    "data/ds3_injection_en.jsonl", mode="check", group_field="attack_type",
    filter=lambda r: r["scored"],
)
h.to_markdown(h.metrics(results, group_field="attack_type"))

# C4: masking keeps answers useful
import json
records = [json.loads(l) for l in open("data/c4_usefulness_en.jsonl")]
h.to_markdown(h.masking_coverage(records))
```
