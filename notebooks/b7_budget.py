"""B7: budget limits with alerts (80%) and cut-off (100%) for team collections.

Phase A: send calls until the platform-reported budget ratio (recording rule aigov:budget_used_ratio:1h) >= 0.80,
         then measure time until TeamBudget80 arrives at the webhook receiver.
Phase B: keep sending until MaaS returns HTTP 429 (cut-off), then measure time until TeamBudget100 arrives.
Env: MAAS_URL, KEY_COLLECTIONS, PROM_URL, PROM_TOKEN, RECEIVER_URL
"""
import json
import os
import ssl
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

MAAS = os.environ["MAAS_URL"]
MODEL = os.environ["MODEL_ID"]
CTX = ssl.create_default_context()
NOVERIFY = ssl._create_unverified_context()
BUDGET = 20000


def prom(q):
    url = os.environ["PROM_URL"].rstrip("/") + "/api/v1/query?" + urllib.parse.urlencode({"query": q})
    req = urllib.request.Request(url, headers={"Authorization": "Bearer " + os.environ["PROM_TOKEN"]})
    with urllib.request.urlopen(req, context=NOVERIFY, timeout=30) as r:
        res = json.load(r)["data"]["result"]
    return float(res[0]["value"][1]) if res else 0.0


SUBSCRIPTION = os.environ.get("B7_SUBSCRIPTION", "aigov-collections")


def ratio():
    return prom(f'max(aigov:budget_used_ratio:1h{{subscription="{SUBSCRIPTION}"}})')


START = time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime())


def received(alertname):
    """Firing alerts of this name that arrived at the receiver AFTER this run started (ignores older history)."""
    with urllib.request.urlopen(os.environ["RECEIVER_URL"].rstrip("/") + "/api", context=CTX, timeout=15) as r:
        return [e for e in json.load(r) if e["alert"] == alertname and e["status"] == "firing" and e["received"] >= START
                and e.get("team") == SUBSCRIPTION]


def call():
    body = json.dumps({"model": MODEL, "max_tokens": 400, "temperature": 0.7,
                       "messages": [{"role": "user", "content": "Write a 250-word overview of microfinance for collections staff."}]}).encode()
    req = urllib.request.Request(MAAS + "/v1/chat/completions", data=body, method="POST",
                                 headers={"Authorization": "Bearer " + os.environ["KEY_COLLECTIONS"], "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, context=CTX, timeout=120) as r:
            return r.status, json.load(r).get("usage", {}).get("total_tokens", 0)
    except urllib.error.HTTPError as e:
        return e.code, 0


def wait_alert(name, t_start, timeout=420):
    if VERBOSE:
        print(f"$ watch receiver for {name}   # PrometheusRule on Limitador token metrics -> Alertmanager -> webhook", flush=True)
    while time.time() - t_start < timeout:
        hits = received(name)
        if hits:
            return time.time() - t_start, hits[0]
        time.sleep(5)
    return None, None


VERBOSE = os.environ.get("B7_VERBOSE") == "1"


def show(code, tok, sent):
    if VERBOSE:
        print(f"  HTTP {code}  +{tok:>3} tokens  ->  {sent:>6,} / {BUDGET:,} ({sent / BUDGET:5.1%})", flush=True)


def main():
    sent_tokens = 0
    log = []
    if VERBOSE:
        print('$ curl -s "$MAAS_URL/v1/chat/completions" -H "Authorization: Bearer $KEY_COLLECTIONS" \\', flush=True)
        print('    -d \'{"model":"$MODEL_ID","max_tokens":400,', flush=True)
        print('         "messages":[{"role":"user","content":"Write a 250-word overview of microfinance..."}]}\'', flush=True)
        print("  (4 requests in parallel, repeated; each response reports usage.total_tokens)", flush=True)
    print(f"start: platform budget ratio = {ratio():.1%}")
    # Phase A: to 80%
    with ThreadPoolExecutor(max_workers=4) as ex:
        while True:
            for code, tok in ex.map(lambda _: call(), range(4)):
                sent_tokens += tok
                log.append(code)
                show(code, tok, sent_tokens)
            if sent_tokens >= 0.8 * BUDGET:
                break
    t80 = time.time()
    print(f"client tokens sent: {sent_tokens} (~{sent_tokens / BUDGET:.0%}); waiting for TeamBudget80 ...")
    dt80, ev = wait_alert("TeamBudget80", t80)
    print(f"TeamBudget80 received after {dt80 and round(dt80)}s: {ev and ev['summary']} | platform ratio now {ratio():.1%}")
    # Phase B: to 100% -> 429
    first429 = None
    while first429 is None and len(log) < 400:
        code, tok = call()
        sent_tokens += tok
        log.append(code)
        show(code, tok, sent_tokens)
        if code == 429:
            first429 = time.time()
    print(f"cut-off: first HTTP 429 after {sent_tokens} client tokens (budget {BUDGET}); total calls {len(log)}, 200s={log.count(200)}, 429s={log.count(429)}")
    for _ in range(3):
        print("  retry after cut-off ->", call()[0])
    dt100, ev = wait_alert("TeamBudget100", first429 or time.time())
    print(f"TeamBudget100 received {dt100 and round(dt100)}s after cut-off: {ev and ev['summary']}")


if __name__ == "__main__":
    main()
