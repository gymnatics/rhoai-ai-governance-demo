// F1: End-to-end audit trail, as the read-only auditor (Keycloak user aigov-auditor1, MLflow view only).
// Env: AIGOV_AUDITOR1_PASSWORD. Precondition: audit traces exist in experiment aigov-audit (notebooks/audit_client.py).
import { start, caption, login, finish, DASH, KUBECONFIG } from './lib.mjs';
import { execFileSync } from 'node:child_process';

const NAME = 'F1-audit-trail';
const rec = await start(NAME);
const { page } = rec;

await login(page, 'aigov-auditor1', process.env.AIGOV_AUDITOR1_PASSWORD);
await caption(page, 'F1 · Audit trail. Signed in as aigov-auditor1 (Keycloak SSO), a read-only auditor: MLflow view only, no project or pod access', 3500);

await page.goto(`${DASH}/develop-train/mlflow/experiments?workspace=${process.env.DEMO_NS}`);
await page.getByRole('link', { name: 'aigov-audit' }).waitFor({ timeout: 60000 });
await caption(page, 'Develop & train → Experiments → workspace ai-governance-demo → experiment "aigov-audit" (one trace per guarded LLM call)', 2500);
await page.getByRole('link', { name: 'aigov-audit' }).click();
await page.getByText('Traces', { exact: true }).first().click();
await page.getByText(/blocked before model|\[NIK\]/).first().waitFor({ timeout: 60000 });
await caption(page, 'Every call is recorded with the MASKED prompt the model received, the response and the guardrail decision. No raw PII is stored', 4500);

await page.getByText(/Validate KTP data/).first().click();
await caption(page, 'Trace detail: id-card-ocr app. The model may see NIK, but the audit copy is always strictly masked', 3500);
const more = page.getByText(/^\+\d+$/).first();
if (await more.isVisible().catch(() => false)) await more.click();
await caption(page, 'Tags: request_id · end_user · app · api_key_name · subscription · model_id + model_uri (version) · guardrail_decision · rails_triggered · pii_types', 6000);
// close the tag popover and the trace drawer explicitly (Escape does not close the popover)
await page.mouse.click(700, 500).catch(() => {});
await page.waitForTimeout(500);
const closeBtn = page.locator('button[aria-label="Close"], button:has(svg[data-icon="close"])').first();
if (await closeBtn.isVisible().catch(() => false)) await closeBtn.click().catch(() => {});
else await page.goto(`${DASH}/develop-train/mlflow/experiments/1/traces?workspace=${process.env.DEMO_NS}`);
await page.getByText('<blocked before model>').first().waitFor({ timeout: 30000 }).catch(() => {});
await page.getByText('<blocked before model>').first().click().catch(() => {});
await caption(page, 'A prompt-injection attempt: blocked on input by "self check input". It never reached the model, and the decision is recorded', 4500);
await page.keyboard.press('Escape').catch(() => {});

// Prove read-only with REAL calls as this user: MLflow API (read vs write) + Kubernetes authorization
const kc = process.env.AUDITOR_KUBECONFIG;
const run = (...a) => { try { return execFileSync('oc', a, { env: { ...process.env, KUBECONFIG: kc }, encoding: 'utf8' }).trim(); } catch (e) { return (e.stdout || 'no').trim(); } };
const tok = run('whoami', '-t');
const ML = `${DASH}/mlflow/api/2.0/mlflow`;
const hdr = { Authorization: `Bearer ${tok}`, 'X-MLFLOW-WORKSPACE': process.env.DEMO_NS, 'Content-Type': 'application/json' };
const rd = await fetch(`${ML}/experiments/search?max_results=5`, { headers: hdr });
const wr = await fetch(`${ML}/experiments/create`, { method: 'POST', headers: hdr, body: JSON.stringify({ name: 'auditor-write-attempt' }) });
const show = (r) => (r.ok ? `allowed (HTTP ${r.status})` : `denied (HTTP ${r.status})`);
const rows = [
  ['Read audit traces (MLflow API, search)', show(rd)],
  ['Create / modify experiments (MLflow API)', show(wr)],
  ['Read pods / container logs in the demo namespace', run('auth', 'can-i', 'get', 'pods', '--subresource=log', '-n', process.env.DEMO_NS) === 'yes' ? 'allowed' : 'denied'],
  ['Change guardrail configuration (ConfigMaps)', run('auth', 'can-i', 'update', 'configmaps', '-n', process.env.DEMO_NS) === 'yes' ? 'allowed' : 'denied'],
  ['See the model serving project', run('auth', 'can-i', 'get', 'pods', '-n', process.env.MODEL_NS) === 'yes' ? 'allowed' : 'denied'],
];
await page.setContent(`<html><body style="font-family:'Red Hat Text',Arial;margin:48px;background:#fafafa">
 <h2>F1 · Auditor aigov-auditor1: least privilege (live authorization checks)</h2>
 <table style="font-size:22px;border-collapse:collapse" cellpadding="10" border="1">
 ${rows.map(([k, v]) => `<tr><td>${k}</td><td style="font-weight:700;color:${v.startsWith('allowed') ? '#3e8635' : '#c9190b'}">${v}</td></tr>`).join('')}
 </table>
 <p style="font-size:18px;margin-top:24px">Per-request gateway records (subscription, user, model, HTTP status) are also retained for 30 days in Loki
 (LokiStack "usage", Models-as-a-Service showback pipeline, Technology Preview).</p></body></html>`);
await caption(page, 'The auditor can trace any transaction but cannot change, delete, or read raw container logs', 6000);
await finish(rec, NAME);
