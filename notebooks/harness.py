#!/usr/bin/env python3
"""Evaluation harness for a NeMo Guardrails OpenAI-compatible server.

Stdlib only for all core functionality (HTTP via urllib, concurrency via
concurrent.futures). Optional pandas/matplotlib are used ONLY inside clearly
separated helper functions (to_dataframe / plot_*) that degrade gracefully
(raise a clear ImportError message) if those packages aren't installed.

Config via environment variables:
  NEMO_URL         base URL of the guardrails route, no trailing slash
  NEMO_TOKEN       bearer token for Authorization header
  NEMO_VERIFY_TLS  "false" to skip TLS verification (default: verify)
  NEMO_CONFIG_ID   optional default guardrails config id

Run selftest (no network): python3 -I notebooks/harness.py selftest
"""
from __future__ import annotations

import csv
import json
import os
import ssl
import statistics
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any, Callable, Optional


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

def _env_base_url() -> str:
    url = os.environ.get("NEMO_URL", "")
    return url.rstrip("/")


def _env_token() -> Optional[str]:
    return os.environ.get("NEMO_TOKEN") or None


def _env_verify_tls() -> bool:
    return os.environ.get("NEMO_VERIFY_TLS", "true").strip().lower() != "false"


def _env_model() -> str:
    # NeMo forwards the request "model" to the backend (MaaS), so it must be a real model id.
    return os.environ.get("NEMO_MODEL") or os.environ["MODEL_ID"]


def _env_default_config_id() -> Optional[str]:
    return os.environ.get("NEMO_CONFIG_ID") or None


def _ssl_context() -> Optional[ssl.SSLContext]:
    if _env_verify_tls():
        return None  # use default verification
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx


# ---------------------------------------------------------------------------
# Low-level HTTP
# ---------------------------------------------------------------------------

def _post_json(path: str, payload: dict, timeout: int = 60) -> tuple[int, Any, str | None]:
    """POST JSON to {NEMO_URL}{path}. Returns (status_code, parsed_json_or_None, error_or_None)."""
    base_url = _env_base_url()
    if not base_url:
        return (0, None, "NEMO_URL is not set")
    url = base_url + path
    data = json.dumps(payload).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    token = _env_token()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=_ssl_context()) as resp:
            body = resp.read().decode("utf-8", errors="replace")
            try:
                parsed = json.loads(body) if body else {}
            except json.JSONDecodeError:
                parsed = {"_raw_text": body}
            return (resp.status, parsed, None)
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        try:
            parsed = json.loads(body) if body else {}
        except json.JSONDecodeError:
            parsed = {"_raw_text": body}
        return (e.code, parsed, None)
    except urllib.error.URLError as e:
        return (0, None, str(e.reason))
    except Exception as e:  # noqa: BLE001 - surface any failure as an error string
        return (0, None, str(e))


# ---------------------------------------------------------------------------
# Response interpretation (adjust these two functions once real responses
# from the NeMo Guardrails server are seen)
# ---------------------------------------------------------------------------

def _is_blocked(resp: Any, http_status: int = 200) -> bool:
    """Return True if the guardrail response indicates the request was blocked.

    Defensive/best-effort interpretation of several possible response shapes:
      - top-level "status" in {"blocked", "failed", "rejected"}
      - any entry in a rails/results list with a blocked-like status
      - an HTTP 4xx response accompanied by a guardrail-looking message
    """
    if not isinstance(resp, dict):
        return False

    blocked_values = {"blocked", "failed", "rejected"}

    status = resp.get("status")
    if isinstance(status, str) and status.lower() in blocked_values:
        return True

    # rails_status / guardrails_data style structures
    rails_status = resp.get("rails_status")
    if isinstance(rails_status, str) and rails_status.lower() in blocked_values:
        return True

    for key in ("guardrails_data", "rails", "results", "checks"):
        entries = resp.get(key)
        if isinstance(entries, list):
            for entry in entries:
                if isinstance(entry, dict):
                    entry_status = entry.get("status") or entry.get("rail_status")
                    if isinstance(entry_status, str) and entry_status.lower() in blocked_values:
                        return True
        elif isinstance(entries, dict):
            entry_status = entries.get("status")
            if isinstance(entry_status, str) and entry_status.lower() in blocked_values:
                return True

    if 400 <= http_status < 500:
        message = resp.get("message") or resp.get("error") or resp.get("detail")
        if isinstance(message, str) and any(
            kw in message.lower() for kw in ("guardrail", "blocked", "policy", "violat")
        ):
            return True

    return False


def _extract_text(resp: Any) -> Optional[str]:
    """Best-effort extraction of altered/modified text from a transform response."""
    if not isinstance(resp, dict):
        return None

    for key in ("content", "text", "modified_text", "output"):
        val = resp.get(key)
        if isinstance(val, str):
            return val

    messages = resp.get("messages")
    if isinstance(messages, list) and messages:
        last = messages[-1]
        if isinstance(last, dict):
            content = last.get("content")
            if isinstance(content, str):
                return content

    choices = resp.get("choices")
    if isinstance(choices, list) and choices:
        first = choices[0]
        if isinstance(first, dict):
            message = first.get("message")
            if isinstance(message, dict):
                content = message.get("content")
                if isinstance(content, str):
                    return content

    return None


# ---------------------------------------------------------------------------
# API calls
# ---------------------------------------------------------------------------

def check(text: str, config_id: Optional[str] = None, timeout: int = 60) -> dict:
    """POST {NEMO_URL}/v1/guardrail/checks and interpret blocked/allowed."""
    cfg = config_id if config_id is not None else _env_default_config_id()
    payload: dict = {
        "model": _env_model(),
        "messages": [{"role": "user", "content": text}],
    }
    if cfg is not None:
        payload["guardrails"] = {"config_id": cfg}

    t0 = time.monotonic()
    status_code, raw, err = _post_json("/v1/guardrail/checks", payload, timeout=timeout)
    latency_s = time.monotonic() - t0

    if err is not None:
        return {
            "blocked": False,
            "status": "error",
            "raw": None,
            "latency_s": latency_s,
            "error": err,
        }

    blocked = _is_blocked(raw, http_status=status_code)
    status_str = None
    if isinstance(raw, dict):
        status_str = raw.get("status")
    if status_str is None:
        status_str = str(status_code)

    # A guardrail that errored did not decide anything: surface it as an error (handled by errors_as),
    # never silently as "allowed".
    rail_error = None
    if isinstance(raw, dict) and str(raw.get("status", "")).lower() == "error":
        gd = raw.get("guardrails_data") or {}
        rail_error = "guardrail error: " + str(gd.get("details") or gd.get("error") or raw)[:300]
    elif status_code >= 500:
        rail_error = f"HTTP {status_code}"

    return {
        "blocked": blocked,
        "status": status_str,
        "raw": raw,
        "latency_s": latency_s,
        "error": rail_error,
    }


def transform(text: str, config_id: Optional[str] = None, timeout: int = 60) -> dict:
    """POST {NEMO_URL}/v1/checks and extract any altered/masked text."""
    cfg = config_id if config_id is not None else _env_default_config_id()
    payload: dict = {
        "model": _env_model(),
        "messages": [{"role": "user", "content": text}],
    }
    if cfg is not None:
        payload["guardrails"] = {"config_id": cfg}

    t0 = time.monotonic()
    status_code, raw, err = _post_json("/v1/checks", payload, timeout=timeout)
    latency_s = time.monotonic() - t0

    if err is not None:
        return {"text_out": None, "raw": None, "latency_s": latency_s, "error": err}

    text_out = _extract_text(raw)
    return {"text_out": text_out, "raw": raw, "latency_s": latency_s, "error": None}


def chat(
    messages: list[dict],
    model: str,
    config_id: Optional[str] = None,
    log: bool = True,
    timeout: int = 60,
) -> dict:
    """POST {NEMO_URL}/v1/chat/completions."""
    cfg = config_id if config_id is not None else _env_default_config_id()
    payload: dict = {
        "model": model,
        "messages": messages,
        "guardrails": {"config_id": cfg},
    }
    if log:
        payload["options"] = {"log": {"activated_rails": True, "llm_calls": True}}

    t0 = time.monotonic()
    status_code, raw, err = _post_json("/v1/chat/completions", payload, timeout=timeout)
    latency_s = time.monotonic() - t0

    if err is not None:
        return {"content": None, "raw": None, "latency_s": latency_s, "error": err}

    content = _extract_text(raw)
    return {"content": content, "raw": raw, "latency_s": latency_s, "error": None}


# ---------------------------------------------------------------------------
# Dataset loading + evaluation
# ---------------------------------------------------------------------------

def _load_jsonl(path: str) -> list[dict]:
    records = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                records.append(json.loads(line))
    return records


def evaluate(
    dataset_path: str,
    mode: str = "check",
    config_id: Optional[str] = None,
    label_field: str = "label",
    group_field: Optional[str] = None,
    filter: Optional[Callable[[dict], bool]] = None,
    errors_as: str = "unsafe_blocked",
    workers: int = 4,
) -> list[dict]:
    """Run check() (or transform()) concurrently over a JSONL dataset.

    errors_as controls how network/parsing errors are scored:
      - "unsafe_blocked": treat the predicted outcome as if it had been
        blocked (conservative: counts as a positive prediction)
      - "safe_passed": treat as allowed (counts as a negative prediction)
      - "exclude": drop the record from results entirely
    """
    if errors_as not in ("unsafe_blocked", "safe_passed", "exclude"):
        raise ValueError(f"invalid errors_as: {errors_as!r}")
    if mode not in ("check", "transform"):
        raise ValueError(f"invalid mode: {mode!r}")

    records = _load_jsonl(dataset_path)
    if filter is not None:
        records = [r for r in records if filter(r)]

    def _run_one(record: dict) -> Optional[dict]:
        text = record["text"]
        if mode == "check":
            result = check(text, config_id=config_id)
            predicted_blocked = result["blocked"]
        else:
            result = transform(text, config_id=config_id)
            predicted_blocked = None  # transform doesn't classify

        truth = record.get(label_field)
        error = result.get("error")

        if error is not None:
            if errors_as == "exclude":
                return None
            predicted_blocked = errors_as == "unsafe_blocked"

        predicted_label = "unsafe" if predicted_blocked else "safe"
        correct = (predicted_label == truth) if truth is not None else None

        row = {
            "id": record.get("id"),
            "text": text,
            "truth": truth,
            "predicted": predicted_label,
            "predicted_blocked": predicted_blocked,
            "correct": correct,
            "latency_s": result.get("latency_s"),
            "error": error,
            "raw": result.get("raw"),
        }
        if group_field is not None:
            row[group_field] = record.get(group_field)
        # carry through a few commonly-used fields if present
        for extra in ("pii_type", "attack_type", "scored", "category", "neg_subtype"):
            if extra in record:
                row[extra] = record[extra]
        return row

    results: list[dict] = []
    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = [executor.submit(_run_one, r) for r in records]
        for fut in as_completed(futures):
            row = fut.result()
            if row is not None:
                results.append(row)

    # keep deterministic ordering by id for readability
    results.sort(key=lambda r: (r.get("id") or ""))
    return results


# ---------------------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------------------

def _percentile(values: list[float], pct: float) -> Optional[float]:
    if not values:
        return None
    values = sorted(values)
    k = (len(values) - 1) * pct
    f = int(k)
    c = min(f + 1, len(values) - 1)
    if f == c:
        return values[f]
    return values[f] + (values[c] - values[f]) * (k - f)


def _metrics_for_group(rows: list[dict]) -> dict:
    tp = fn = fp = tn = 0
    latencies = []
    for r in rows:
        truth = r.get("truth")
        predicted = r.get("predicted")
        if r.get("latency_s") is not None:
            latencies.append(r["latency_s"])
        if truth == "unsafe" and predicted == "unsafe":
            tp += 1
        elif truth == "unsafe" and predicted == "safe":
            fn += 1
        elif truth == "safe" and predicted == "unsafe":
            fp += 1
        elif truth == "safe" and predicted == "safe":
            tn += 1

    n = len(rows)
    recall = tp / (tp + fn) if (tp + fn) else None
    precision = tp / (tp + fp) if (tp + fp) else None
    f1 = (
        2 * precision * recall / (precision + recall)
        if precision and recall and (precision + recall) > 0
        else None
    )
    fpr = fp / (fp + tn) if (fp + tn) else None
    correct_rows = [r for r in rows if r.get("correct") is not None]
    accuracy = (
        sum(1 for r in correct_rows if r["correct"]) / len(correct_rows)
        if correct_rows
        else None
    )

    return {
        "n": n,
        "tp": tp,
        "fn": fn,
        "fp": fp,
        "tn": tn,
        "recall": recall,
        "precision": precision,
        "f1": f1,
        "fpr": fpr,
        "accuracy": accuracy,
        "p50_latency_s": _percentile(latencies, 0.50),
        "p95_latency_s": _percentile(latencies, 0.95),
    }


def metrics(results: list[dict], group_field: Optional[str] = None) -> list[dict]:
    """Compute overall metrics, and per-group metrics if group_field is given.

    Returns a list of dict rows, each with a "group" key ("overall" or the
    group value) plus the metric fields from _metrics_for_group.
    """
    rows = [{"group": "overall", **_metrics_for_group(results)}]

    if group_field is not None:
        groups: dict[str, list[dict]] = {}
        for r in results:
            key = r.get(group_field)
            groups.setdefault(key, []).append(r)
        for key in sorted(groups, key=lambda k: (k is None, str(k))):
            rows.append({"group": key, **_metrics_for_group(groups[key])})

    return rows


def to_markdown(rows: list[dict]) -> str:
    if not rows:
        return ""
    headers = list(rows[0].keys())
    lines = ["| " + " | ".join(headers) + " |", "| " + " | ".join(["---"] * len(headers)) + " |"]
    for row in rows:
        cells = []
        for h in headers:
            v = row.get(h)
            if isinstance(v, float):
                cells.append(f"{v:.3f}")
            else:
                cells.append("" if v is None else str(v))
        lines.append("| " + " | ".join(cells) + " |")
    table = "\n".join(lines)
    return table


def to_csv(rows: list[dict], path: str) -> None:
    if not rows:
        with open(path, "w", encoding="utf-8") as f:
            f.write("")
        return
    headers = list(rows[0].keys())
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=headers)
        writer.writeheader()
        for row in rows:
            writer.writerow(row)


# ---------------------------------------------------------------------------
# Masking coverage (C2/C4)
# ---------------------------------------------------------------------------

def masking_coverage(records: list[dict], config_id: Optional[str] = None, workers: int = 4) -> list[dict]:
    """For each record with pii_values, call transform() and measure what
    fraction of the original PII values no longer appear verbatim in the
    transformed text. Returns per-type coverage rows.

    Each input record must have "text" and "pii_values" (list[str]); a
    "pii_type" or "pii_types" field is used for grouping if present.
    """

    def _run_one(record: dict) -> dict:
        text = record["text"]
        pii_values = record.get("pii_values") or []
        result = transform(text, config_id=config_id)
        text_out = result.get("text_out")
        if not pii_values:
            coverage = None
        elif text_out is None:
            coverage = 0.0
        else:
            masked = sum(1 for v in pii_values if v not in text_out)
            coverage = masked / len(pii_values)

        types = record.get("pii_types")
        if types is None:
            pii_type = record.get("pii_type", "unknown")
            types = [pii_type]

        return {
            "id": record.get("id"),
            "coverage": coverage,
            "pii_types": types,
            "error": result.get("error"),
        }

    per_record: list[dict] = []
    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = [executor.submit(_run_one, r) for r in records]
        for fut in as_completed(futures):
            per_record.append(fut.result())

    # aggregate per pii_type (a record can contribute to multiple types)
    by_type: dict[str, list[float]] = {}
    for rec in per_record:
        if rec["coverage"] is None:
            continue
        for t in rec["pii_types"]:
            by_type.setdefault(t, []).append(rec["coverage"])

    rows = []
    for t in sorted(by_type):
        values = by_type[t]
        rows.append({
            "pii_type": t,
            "n": len(values),
            "avg_coverage": sum(values) / len(values) if values else None,
        })
    return rows


# ---------------------------------------------------------------------------
# Explain
# ---------------------------------------------------------------------------

def explain(result: dict) -> None:
    """Pretty-print the raw guardrail response for one evaluate() result row."""
    print(f"id: {result.get('id')}")
    print(f"text: {result.get('text')}")
    print(f"truth: {result.get('truth')}  predicted: {result.get('predicted')}  "
          f"correct: {result.get('correct')}")
    print(f"latency_s: {result.get('latency_s')}  error: {result.get('error')}")
    print("raw response:")
    print(json.dumps(result.get("raw"), indent=2, ensure_ascii=False))


# ---------------------------------------------------------------------------
# Optional pandas/matplotlib helpers (degrade gracefully)
# ---------------------------------------------------------------------------

def to_dataframe(rows: list[dict]):
    """Convert metrics()/evaluate() rows to a pandas DataFrame. Requires pandas."""
    try:
        import pandas as pd
    except ImportError as e:
        raise ImportError(
            "to_dataframe() requires pandas; install it or use to_markdown()/to_csv() instead."
        ) from e
    return pd.DataFrame(rows)


def plot_metric_bar(rows: list[dict], metric: str, group_key: str = "group"):
    """Bar-plot a metric across groups. Requires matplotlib."""
    try:
        import matplotlib.pyplot as plt
    except ImportError as e:
        raise ImportError(
            "plot_metric_bar() requires matplotlib; install it to use plotting helpers."
        ) from e
    labels = [str(r.get(group_key)) for r in rows]
    values = [r.get(metric) for r in rows]
    fig, ax = plt.subplots()
    ax.bar(labels, [v if v is not None else 0 for v in values])
    ax.set_ylabel(metric)
    ax.set_title(f"{metric} by {group_key}")
    plt.xticks(rotation=45, ha="right")
    plt.tight_layout()
    return fig


# ---------------------------------------------------------------------------
# Selftest (no network)
# ---------------------------------------------------------------------------

def _selftest() -> None:
    # Synthetic in-memory results: 10 unsafe, 10 safe.
    # unsafe: 8 correctly blocked (TP), 2 incorrectly allowed (FN) -> recall 0.8
    # safe:   9 correctly allowed (TN), 1 incorrectly blocked (FP) -> FPR 0.1
    fake_results = []
    for i in range(8):
        fake_results.append({
            "id": f"u{i}", "truth": "unsafe", "predicted": "unsafe",
            "correct": True, "latency_s": 0.1 + i * 0.01, "error": None,
        })
    for i in range(2):
        fake_results.append({
            "id": f"u{8+i}", "truth": "unsafe", "predicted": "safe",
            "correct": False, "latency_s": 0.2, "error": None,
        })
    for i in range(9):
        fake_results.append({
            "id": f"s{i}", "truth": "safe", "predicted": "safe",
            "correct": True, "latency_s": 0.15, "error": None,
        })
    for i in range(1):
        fake_results.append({
            "id": f"s{9+i}", "truth": "safe", "predicted": "unsafe",
            "correct": False, "latency_s": 0.3, "error": None,
        })

    rows = metrics(fake_results)
    overall = rows[0]
    assert overall["tp"] == 8, overall
    assert overall["fn"] == 2, overall
    assert overall["fp"] == 1, overall
    assert overall["tn"] == 9, overall
    assert abs(overall["recall"] - 0.8) < 1e-9, overall
    assert abs(overall["precision"] - (8 / 9)) < 1e-9, overall
    assert abs(overall["fpr"] - 0.1) < 1e-9, overall
    assert abs(overall["accuracy"] - 0.85) < 1e-9, overall
    expected_f1 = 2 * overall["precision"] * overall["recall"] / (overall["precision"] + overall["recall"])
    assert abs(overall["f1"] - expected_f1) < 1e-9, overall
    assert overall["n"] == 20, overall

    # group_field test
    for r in fake_results:
        r["category"] = "typeA" if r["id"].startswith("u") else "typeB"
    grouped = metrics(fake_results, group_field="category")
    group_names = {r["group"] for r in grouped}
    assert {"overall", "typeA", "typeB"} <= group_names, grouped

    # percentile sanity
    p50 = _percentile([0.1, 0.2, 0.3, 0.4], 0.5)
    assert p50 is not None

    # to_markdown should not raise
    md = to_markdown(rows)
    assert "recall" in md

    print("selftest OK: TP=8 FN=2 FP=1 TN=9 recall=0.800 precision={:.3f} f1={:.3f} fpr=0.100 accuracy=0.850".format(
        overall["precision"], overall["f1"]
    ))


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "selftest":
        _selftest()
    else:
        print(__doc__)
