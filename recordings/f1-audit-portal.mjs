// F1 (portal path): the auditor works from an audit portal, not the ML platform.
// Audit portal (read-only, reads MLflow) → search a request id → masked record → export evidence →
// "Open in MLflow" for the full trace → the same record received by the SIEM collector (OpenTelemetry, dual export).
// Env: PORTAL_URL, PORTAL_USER, PORTAL_PASSWORD, AUDITOR_PASSWORD (MLflow drill-down), RID (request id to look up;
//      default: the newest request), optional AUDITOR_USER, DEMO_NS, OTEL_DEPLOY.
import { start, caption, login, finish, oc } from './lib.mjs';

const NAME = 'F1-audit-portal';
const PORTAL = process.env.PORTAL_URL;
if (!PORTAL) throw new Error('set PORTAL_URL to the audit portal route');
const NS = process.env.DEMO_NS || 'ai-governance-demo';
const AUDITOR = process.env.AUDITOR_USER || 'aigov-auditor1';
const OTEL = process.env.OTEL_DEPLOY || 'aigov-audit-otel-collector';
const rec = await start(NAME);
const { page } = rec;
page.setDefaultTimeout(60000);
const step = async (label, fn) => { try { await fn(); } catch (e) { console.error(`step "${label}" failed: ${e.message.split('\n')[0]}`); } };
await page.addLocatorHandler(page.getByText('Welcome to OpenShift AI'), async () => { await page.getByRole('button', { name: 'Close' }).first().click(); });

// 1. portal sign-in + overview
await page.goto(PORTAL, { waitUntil: 'domcontentloaded' });
await page.getByRole('textbox', { name: 'User' }).waitFor();
await caption(page, 'F1 · The auditor works from an audit portal: a read-only view of the AI audit trail, fed from MLflow', 3500);
await page.getByRole('textbox', { name: 'User' }).fill(process.env.PORTAL_USER || 'auditor');
await page.getByRole('textbox', { name: 'Password' }).fill(process.env.PORTAL_PASSWORD);
await page.getByRole('button', { name: 'Sign in' }).click();
await page.getByText('Requests', { exact: true }).first().waitFor();
// charts draw lazily: wait until the three chart canvases exist (falls back after 30 s)
await page.waitForFunction(() => document.querySelectorAll('[data-testid="stVegaLiteChart"] canvas, [data-testid="stVegaLiteChart"] svg').length >= 3, null, { timeout: 30000 }).catch(() => console.error('charts not drawn'));
await page.waitForTimeout(1500);
await caption(page, 'Overview: every guarded AI request, the guardrail decisions per application, and the personal-data types found', 5000);

// 2. search a request id
await page.getByRole('tab', { name: 'Search & detail' }).click();
await page.waitForTimeout(1200);
const rid = process.env.RID || '';
if (rid) {
  await page.getByRole('textbox', { name: /Request id/ }).pressSequentially(rid.slice(0, 8), { delay: 60 });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(3000);
  await caption(page, `Search by the audit record id from the chat (${rid.slice(0, 8)}…): one matching request`, 3500);
}
await page.mouse.move(960, 600);
for (let i = 0; i < 5; i++) { await page.mouse.wheel(0, 250); await page.waitForTimeout(120); }
await caption(page, 'The record: what the model received (masked), the answer, who, which app, key, subscription and model version, and the decision', 6000);
const href = await page.getByRole('link', { name: /Open this trace in MLflow/ }).getAttribute('href').catch(() => null);

// 3. export evidence
await page.mouse.wheel(0, -3000);
await page.getByRole('tab', { name: 'Export evidence' }).click();
await page.waitForTimeout(1200);
await step('export', async () => {
  const [d] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), page.getByRole('button', { name: 'Excel', exact: true }).click()]);
  await d.cancel().catch(() => {});
});
await caption(page, 'Evidence export as CSV, Excel or JSON: the filtered records, stamped with who exported them and when, each with its MLflow link', 5000);

// 4. drill down: the same trace in MLflow
if (href && process.env.AUDITOR_PASSWORD) {
  await caption(page, '"Open this trace in MLflow" for the full detail: the auditor signs in to OpenShift AI (read-only)', 3000);
  await login(page, AUDITOR, process.env.AUDITOR_PASSWORD);
  await page.goto(href, { waitUntil: 'domcontentloaded' });
  await step('trace drawer', async () => { await page.getByText(/model_received_prompt_masked|Inputs/).first().waitFor({ timeout: 90000 }); });
  await page.waitForTimeout(2000);
  await step('tags', async () => { const more = page.getByText(/^\+\d+$/).first(); if (await more.isVisible().catch(() => false)) await more.click(); });
  await caption(page, 'The same request in MLflow (Develop & train → Experiments): masked input, response and all audit tags', 5500);
}

// 5. the SIEM copy: what the OpenTelemetry collector received for this request
const logs = oc('logs', '-n', NS, `deploy/${OTEL}`, '--since=48h');
let lines = [];
if (logs && rid) {
  const at = logs.indexOf(rid);
  const block = at >= 0 ? logs.slice(Math.max(0, logs.lastIndexOf('Span #', at)), at + 6000) : '';
  lines = block.split('\n').filter((l) => /Span #|Name +:|request_id|audit\.|mlflow\.spanInputs/.test(l)).slice(0, 18)
    .map((l) => l.replace(/\s+/g, ' ').trim().slice(0, 150));
}
const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
await page.setContent(`<html><body style="margin:0;font-family:'Red Hat Text',Arial,sans-serif;background:#f2f2f2">
  <div style="padding:26px 40px 10px;font-weight:700;font-size:26px">F1 · The same record in the bank's SIEM pipeline</div>
  <div style="padding:0 40px 14px;font-size:18px;color:#333">The application exports every audit trace to MLflow <b>and</b>, over OpenTelemetry (OTLP), to a collector that stands in for Splunk / Elastic / Dynatrace (MLflow dual export). Masked values only.</div>
  <pre style="margin:0 40px;background:#151515;color:#c8f7c5;font:17px/1.5 'Red Hat Mono',Menlo,monospace;padding:20px;border-radius:8px;white-space:pre-wrap">$ oc logs deploy/${esc(OTEL)} | grep -A40 ${esc(rid.slice(0, 8))}   # OpenTelemetry Collector (Red Hat build of OpenTelemetry)
${esc(lines.join('\n') || '(no matching span found in the collector log)')}</pre>
  <div style="padding:16px 40px;font-size:17px;color:#333">In production the collector's exporter points at your SIEM instead of its log; nothing changes in the application.</div>
</body></html>`);
await caption(page, 'SIEM copy of the same request: request_id, application, user, subscription, decision and PII types, no raw personal data', 7000);
await caption(page, 'Auditors get a portal and their SIEM; MLflow on OpenShift AI stays the system of record for the full trace', 4000);
await finish(rec, NAME);
