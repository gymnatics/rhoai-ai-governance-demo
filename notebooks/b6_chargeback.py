"""B6: token visibility, cost tracking and chargeback per team / application / model.

1. Snapshot platform counters (Prometheus/Thanos: Limitador authorized_hits = tokens, authorized_calls = requests,
   labelled by subscription, user, cost_center, model) BEFORE.
2. Send N calls split across 3 team API keys (default 500/300/200), tally usage.total_tokens client-side.
3. Wait for a scrape, snapshot AFTER, delta = platform-reported usage.
4. Chargeback CSV per team: calls, tokens, IDR cost (price table), difference vs client tally.

Env: MAAS_URL, PROM_URL (thanos-querier route), PROM_TOKEN (token with cluster-monitoring-view),
     KEY_CHATBOT, KEY_IDOCR, KEY_MARKETING. Optional: B6_CALLS="500,300,200", B6_WORKERS=12, PRICE_IDR_PER_TOKEN=0.25
"""
import csv
import datetime as dt
import json
import os
import random
import ssl
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

MAAS = os.environ["MAAS_URL"]
PROM = os.environ["PROM_URL"].rstrip("/")
MODEL = os.environ["MODEL_ID"]
PRICE = float(os.environ.get("PRICE_IDR_PER_TOKEN", "0.25"))
CTX = ssl.create_default_context()
CTX_PROM = ssl._create_unverified_context() if os.environ.get("PROM_INSECURE", "true") == "true" else CTX

TEAMS = [  # (subscription, cost centre, env var with key)
    ("aigov-chatbot", "cc-digital-chatbot", "KEY_CHATBOT"),
    ("aigov-idocr", "cc-ops-idocr", "KEY_IDOCR"),
    ("aigov-marketing", "cc-marketing", "KEY_MARKETING"),
]
QUESTIONS = [
    "What is a basic savings account?", "How do I block a lost debit card?", "Explain a time deposit in one sentence.",
    "What documents are needed for a microfinance loan?", "How long does an interbank transfer take?",
    "What is the minimum balance for Tabungan?", "How do I activate mobile banking?", "What is a time deposit?",
    "Give two tips to avoid phishing.", "What is the difference between debit and credit cards?",
]


def prom(query):
    url = PROM + "/api/v1/query?" + urllib.parse.urlencode({"query": query})
    req = urllib.request.Request(url, headers={"Authorization": "Bearer " + os.environ["PROM_TOKEN"]})
    with urllib.request.urlopen(req, context=CTX_PROM, timeout=30) as r:
        res = json.load(r)["data"]["result"]
    return {m["metric"].get("subscription", "?"): float(m["value"][1]) for m in res}


def snapshot():
    sel = '{subscription=~"ai-governance-demo-(chatbot|idocr|marketing)"}'
    return prom(f"sum by (subscription) (authorized_hits{sel})"), prom(f"sum by (subscription) (authorized_calls{sel})")


def call(key):
    body = json.dumps({"model": MODEL, "max_tokens": 64, "temperature": 0.3,
                       "messages": [{"role": "user", "content": random.choice(QUESTIONS)}]}).encode()
    req = urllib.request.Request(MAAS + "/v1/chat/completions", data=body, method="POST",
                                 headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, context=CTX, timeout=120) as r:
            return r.status, json.load(r).get("usage", {}).get("total_tokens", 0)
    except urllib.error.HTTPError as e:
        return e.code, 0
    except Exception:
        return 0, 0


def main(out_dir="reports"):
    counts = [int(x) for x in os.environ.get("B6_CALLS", "500,300,200").split(",")]
    jobs = []
    for (sub, cc, keyvar), n in zip(TEAMS, counts):
        jobs += [(sub, os.environ[keyvar])] * n
    random.seed(7)
    random.shuffle(jobs)

    hits0, calls0 = snapshot()
    t0 = dt.datetime.now(dt.timezone.utc)
    client = {sub: {"calls_ok": 0, "calls_failed": 0, "tokens": 0} for sub, _, _ in TEAMS}
    with ThreadPoolExecutor(max_workers=int(os.environ.get("B6_WORKERS", "12"))) as ex:
        for (sub, _), (code, tok) in zip(jobs, ex.map(lambda j: call(j[1]), jobs)):
            if code == 200:
                client[sub]["calls_ok"] += 1
                client[sub]["tokens"] += tok
            else:
                client[sub]["calls_failed"] += 1
    t1 = dt.datetime.now(dt.timezone.utc)
    print(f"sent {len(jobs)} calls in {(t1 - t0).total_seconds():.0f}s; waiting 75s for Prometheus scrape ...")
    time.sleep(75)
    hits1, calls1 = snapshot()

    rows = []
    for sub, cc, _ in TEAMS:
        p_tok = hits1.get(sub, 0) - hits0.get(sub, 0)
        p_calls = calls1.get(sub, 0) - calls0.get(sub, 0)
        c = client[sub]
        diff = (p_tok - c["tokens"]) / c["tokens"] * 100 if c["tokens"] else 0.0
        rows.append({"team_subscription": sub, "cost_center": cc, "model": MODEL,
                     "platform_calls": int(p_calls), "platform_tokens": int(p_tok), "cost_idr": round(p_tok * PRICE, 2),
                     "client_calls_ok": c["calls_ok"], "client_calls_failed": c["calls_failed"], "client_tokens": c["tokens"],
                     "difference_pct": round(diff, 3)})
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, f"chargeback-{t0:%Y%m%dT%H%MZ}.csv")
    with open(path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)
    print(f"window {t0:%H:%M:%S}-{t1:%H:%M:%S} UTC, price IDR {PRICE}/token -> {path}")
    hdr = ["team_subscription", "cost_center", "platform_calls", "platform_tokens", "cost_idr", "client_tokens", "difference_pct"]
    print("| " + " | ".join(hdr) + " |\n|" + "---|" * len(hdr))
    for r in rows:
        print("| " + " | ".join(str(r[k]) for k in hdr) + " |")
    tot_p = sum(r["platform_tokens"] for r in rows)
    tot_c = sum(r["client_tokens"] for r in rows)
    print(f"TOTAL platform {tot_p} tokens (IDR {tot_p * PRICE:,.2f}) vs client {tot_c}: diff {((tot_p - tot_c) / tot_c * 100) if tot_c else 0:.3f}%")
    return rows


if __name__ == "__main__":
    main()
