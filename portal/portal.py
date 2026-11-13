"""Audit portal: read-only view of the guardrail audit trail for auditors and compliance teams.

Reads the masked audit traces from MLflow (experiment written by notebooks/audit_client.py) through the MLflow API,
as a ServiceAccount that only has the MLflow *view* role. Overview, search, trace detail with a link to the same trace
in MLflow, and evidence export (CSV / Excel / JSON). Sample app built on the platform APIs, not a product feature.

Env: MLFLOW_TRACKING_URI, MLFLOW_TRACKING_TOKEN, MLFLOW_WORKSPACE, AUDIT_EXPERIMENT, DASH_URL (for MLflow links),
     PORTAL_USER, PORTAL_PASSWORD, optional BRAND.
"""
import hmac
import io
import json
import os
from datetime import datetime, timedelta, timezone

import mlflow
import pandas as pd
import streamlit as st

BRAND = os.environ.get("BRAND", "Acme Bank")
WORKSPACE = os.environ.get("MLFLOW_WORKSPACE", "")
EXPERIMENT = os.environ.get("AUDIT_EXPERIMENT", "aigov-audit")
DASH = os.environ.get("DASH_URL", "").rstrip("/")
TAGS = ["request_id", "end_user", "app", "config_id", "api_key_name", "subscription", "model_id", "model_uri",
        "serving_runtime", "guardrail_decision", "rails_triggered", "pii_types", "prompt_sha256_12"]
DECISION_LABEL = {"masked": "masked (PII replaced, answered)", "blocked_input": "blocked before the model",
                  "blocked_output": "answer blocked by output check", "allowed": "allowed (no PII)"}

st.set_page_config(page_title=f"{BRAND} · AI audit portal", page_icon="🛡️", layout="wide")


# ---------------------------------------------------------------- login (demo-grade; production would use SSO)
def login_gate():
    if st.session_state.get("auth"):
        return
    st.title(f"{BRAND} · AI audit portal")
    st.caption("Read-only access to the AI guardrail audit trail")
    with st.form("login"):
        u = st.text_input("User")
        p = st.text_input("Password", type="password")
        if st.form_submit_button("Sign in"):
            ok = hmac.compare_digest(u, os.environ.get("PORTAL_USER", "auditor")) and \
                 hmac.compare_digest(p, os.environ.get("PORTAL_PASSWORD", "\0unset"))
            if ok:
                st.session_state.auth = u
                st.rerun()
            st.error("Wrong user or password")
    st.stop()


# ---------------------------------------------------------------- data
@st.cache_data(ttl=30, show_spinner="Reading the audit trail from MLflow…")
def load(limit: int = 2000):
    if WORKSPACE:
        mlflow.set_workspace(WORKSPACE)
    c = mlflow.MlflowClient()
    exp = c.get_experiment_by_name(EXPERIMENT)
    if exp is None:
        return pd.DataFrame(), None
    rows, traces, token = [], [], None
    while len(traces) < limit:   # the API caps one page at 500
        page = c.search_traces(locations=[exp.experiment_id], max_results=500, page_token=token)
        traces += list(page)
        token = getattr(page, "token", None)
        if not token:
            break
    for t in traces:
        i = t.info
        tags = i.tags or {}
        ts = getattr(i, "request_time", None) or getattr(i, "timestamp_ms", None)
        row = {"time": datetime.fromtimestamp(ts / 1000, tz=timezone.utc) if ts else None,
               "trace_id": i.trace_id,
               "masked_prompt": getattr(i, "request_preview", "") or "",
               "response": getattr(i, "response_preview", "") or "",
               "latency_ms": getattr(i, "execution_duration", None)}
        row.update({k: tags.get(k, "") for k in TAGS})
        rows.append(row)
    df = pd.DataFrame(rows)
    if not df.empty:
        df = df.sort_values("time", ascending=False).reset_index(drop=True)
    return df, exp.experiment_id


def mlflow_link(exp_id, trace_id):
    if not DASH:
        return ""
    return f"{DASH}/develop-train/mlflow/experiments/{exp_id}/traces?workspace={WORKSPACE}&selectedEvaluationId={trace_id}"


# ---------------------------------------------------------------- UI
login_gate()
df, exp_id = load()
top_l, top_r = st.columns([4, 1])
top_l.title(f"{BRAND} · AI audit portal")
top_l.caption(f"Signed in as **{st.session_state.auth}** · read-only · source: MLflow experiment `{EXPERIMENT}` "
              f"(workspace `{WORKSPACE}`), every guarded AI request, masked")
if top_r.button("Refresh"):
    load.clear()
    st.rerun()
if df.empty:
    st.info("No audit records yet.")
    st.stop()

tab_over, tab_search, tab_export, tab_siem = st.tabs(["Overview", "Search & detail", "Export evidence", "About the data"])

with tab_over:
    c1, c2, c3, c4, c5 = st.columns(5)
    c1.metric("Requests", len(df))
    c2.metric("Masked", int((df.guardrail_decision == "masked").sum()))
    c3.metric("Blocked before model", int((df.guardrail_decision == "blocked_input").sum()))
    c4.metric("Answers blocked", int((df.guardrail_decision == "blocked_output").sum()))
    c5.metric("Applications", df.app.replace("", pd.NA).nunique())
    a, b = st.columns(2)
    with a:
        st.subheader("Decisions by application")
        st.bar_chart(df.pivot_table(index="app", columns="guardrail_decision", values="trace_id", aggfunc="count").fillna(0))
    with b:
        st.subheader("Personal data types found")
        pii = df.pii_types[df.pii_types.ne("none") & df.pii_types.ne("")].str.split(",").explode().value_counts()
        if pii.empty:
            st.caption("none")
        else:
            st.bar_chart(pii)
    st.subheader("Requests per hour")
    st.bar_chart(df.dropna(subset=["time"]).set_index("time").resample("1h").size().rename("requests"))

with tab_search:
    f1, f2, f3, f4 = st.columns([2, 1, 1, 1])
    q = f1.text_input("Request id, end user or text (masked)", placeholder="e.g. af80f83c or demo@assistant")
    apps = f2.multiselect("Application", sorted(x for x in df.app.unique() if x))
    decs = f3.multiselect("Decision", sorted(x for x in df.guardrail_decision.unique() if x))
    days = f4.selectbox("Period", ["All", "Last 24 h", "Last 7 days"])
    v = df
    if q:
        ql = q.lower()
        v = v[v.request_id.str.lower().str.startswith(ql) | v.end_user.str.lower().str.contains(ql, regex=False)
              | v.masked_prompt.str.lower().str.contains(ql, regex=False) | v.trace_id.str.lower().str.contains(ql, regex=False)]
    if apps:
        v = v[v.app.isin(apps)]
    if decs:
        v = v[v.guardrail_decision.isin(decs)]
    if days != "All":
        since = datetime.now(timezone.utc) - (timedelta(days=1) if days == "Last 24 h" else timedelta(days=7))
        v = v[v.time >= since]
    st.session_state.filtered = v
    st.caption(f"{len(v)} of {len(df)} requests")
    show = v[["time", "request_id", "end_user", "app", "guardrail_decision", "pii_types", "masked_prompt"]].copy()
    show["time"] = show.time.dt.strftime("%Y-%m-%d %H:%M:%S UTC")
    st.dataframe(show, hide_index=True, use_container_width=True, height=min(38 * (len(show) + 1), 330))
    if len(v):
        labels = [f"{t:%Y-%m-%d %H:%M:%S} · {rid} · {d}" if pd.notna(t) else f"{rid} · {d}"
                  for t, rid, d in zip(v.time, v.request_id, v.guardrail_decision)]
        idx = st.selectbox("Open request", range(len(v)), format_func=lambda i: labels[i], key="open_req")
        r = v.iloc[idx]
        st.divider()
        st.subheader(f"Request {r.request_id}")
        l, m = st.columns([3, 2])
        with l:
            st.markdown(f"**Decision:** `{r.guardrail_decision}`: {DECISION_LABEL.get(r.guardrail_decision, '')}")
            st.markdown("**What the model received (masked):**")
            st.code(r.masked_prompt or "-", language=None)
            st.markdown("**Response returned to the user:**")
            st.code(r.response or "-", language=None)
            link = mlflow_link(exp_id, r.trace_id)
            if link:
                st.link_button("Open this trace in MLflow ↗", link)
        with m:
            st.markdown("**Audit record**")
            st.table(pd.DataFrame({"field": ["time (UTC)"] + TAGS + ["trace_id"],
                                   "value": [str(r.time)] + [r[k] for k in TAGS] + [r.trace_id]}).set_index("field"))
    else:
        st.caption("No requests match the search.")

with tab_export:
    v = st.session_state.get("filtered", df)
    st.markdown(f"Exports the **{len(v)}** requests matching the current search (all requests if no filter is set). "
                "Values are already masked; no raw personal data is included.")
    meta = {"exported_at_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"), "exported_by": st.session_state.auth,
            "source": f"MLflow experiment {EXPERIMENT} (workspace {WORKSPACE})", "records": len(v)}
    out = v.copy()
    out["time"] = out.time.astype(str)
    out["mlflow_link"] = [mlflow_link(exp_id, t) for t in out.trace_id]
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%MZ")
    e1, e2, e3 = st.columns(3)
    e1.download_button("CSV", out.to_csv(index=False), f"ai-audit-{stamp}.csv", "text/csv")
    buf = io.BytesIO()
    with pd.ExcelWriter(buf, engine="openpyxl") as xw:
        pd.DataFrame([meta]).to_excel(xw, sheet_name="export", index=False)
        out.to_excel(xw, sheet_name="requests", index=False)
    e2.download_button("Excel", buf.getvalue(), f"ai-audit-{stamp}.xlsx",
                       "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    e3.download_button("JSON", json.dumps({"export": meta, "requests": out.to_dict(orient="records")}, indent=1, default=str),
                       f"ai-audit-{stamp}.json", "application/json")
    st.dataframe(out[["time", "request_id", "app", "guardrail_decision", "pii_types"]].head(50), hide_index=True,
                 use_container_width=True)

with tab_siem:
    st.markdown(f"""
**Where these records come from.** Every AI request goes through the guardrail service. The application writes one
audit record per request to MLflow on OpenShift AI: who, which application and API key, which subscription and model
version, what the guardrail decided, and the prompt and answer **after masking**. This portal reads them through the
MLflow API with a read-only identity; it cannot change or delete anything.

**Drill-down.** Every record links to the same trace in MLflow (Develop & train → Experiments), for the full detail.

**Your SIEM.** The same records can be streamed to an existing SIEM or observability platform (Splunk, Elastic,
Dynatrace…) through an OpenTelemetry Collector: the application exports each trace over OTLP to the collector *and* to
MLflow (MLflow dual export). In this demo the collector prints what it receives; in production its exporter points at
your SIEM.

**Retention.** MLflow keeps the records for as long as the experiment exists. Per-request gateway records
(subscription, user, model, status) are also kept in Loki (Technology Preview).
""")
