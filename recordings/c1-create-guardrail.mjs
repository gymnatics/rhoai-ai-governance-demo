// C1: Create a new PII guardrail from scratch, live, in the OpenShift console (Import YAML template), timed on screen.
// Env: ADMIN_PASSWORD. Precondition: project aigov-c1-live does NOT exist (oc delete project aigov-c1-live).
import { start, caption, startStopwatch, login, oc, finish, fastForward, normalSpeed, CONSOLE, KUBECONFIG } from './lib.mjs';
import fs from 'node:fs';

const NAME = 'C1-create-guardrail';
const NS = 'aigov-c1-live';
const md = fs.readFileSync('../runbooks/C1-create-guardrail.md', 'utf8');
const yaml = md.match(/```yaml\n([\s\S]*?)```/)[1];
const rec = await start(NAME);
const { page } = rec;
const t0 = () => Date.now();
let T0;

await login(page, process.env.ADMIN_USER || 'admin', process.env.ADMIN_PASSWORD, CONSOLE);
await page.goto(`${CONSOLE}/k8s/cluster/projects`, { waitUntil: 'domcontentloaded' });
await caption(page, 'C1 · Create a PII guardrail from scratch: OpenShift console only, configuration not code (NeMo Guardrails, GA in RHOAI 3.5)', 3500);
await startStopwatch(page); T0 = t0();

await caption(page, 'Step 1 · Create an empty project for the policy', 1000);
await page.getByRole('button', { name: /Create Project/i }).click();
await page.locator('#input-name, input[name="name"]').first().fill(NS);
await page.getByRole('button', { name: /^Create$/ }).click();
await page.waitForURL(/aigov-c1-live/, { timeout: 30000 }).catch(() => {});

await caption(page, 'Step 2 · Import YAML: paste the PII policy template. The analyst only edits the entity list and the bank-specific patterns', 2500);
await page.goto(`${CONSOLE}/k8s/ns/${NS}/import`, { waitUntil: 'domcontentloaded' });
const editor = page.locator('.monaco-editor').first();
await editor.waitFor({ timeout: 30000 });
// Set the editor content via the Monaco API (typed/pasted text gets auto-indented by the editor)
const set = await page.evaluate((y) => {
  const m = window.monaco?.editor?.getModels?.();
  if (m && m.length) { m[0].setValue(y); return true; }
  return false;
}, yaml);
if (!set) { await editor.click(); await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.insertText(yaml); }
await page.waitForTimeout(800);
await caption(page, 'Entities: PERSON, EMAIL_ADDRESS, PHONE_NUMBER (Presidio) · Patterns: customer number CIF-######## and 16-digit IDs (regex)', 5000);
await caption(page, 'Step 3 · Create: a ConfigMap (the policy) and a NemoGuardrails resource (the guardrail server, authentication on)', 2500);
await page.getByRole('button', { name: /^Create$/ }).click();
await page.waitForTimeout(3000);
const errBox = page.getByText(/An error occurred|Error parsing/).first();
if (await errBox.isVisible().catch(() => false)) throw new Error('Import YAML failed: ' + (await errBox.textContent()));
for (let i = 0; i < 20 && !oc('get', 'nemoguardrails.trustyai.opendatahub.io', 'c1-guardrail', '-n', NS, '-o', 'name'); i++) await page.waitForTimeout(1000);
if (!oc('get', 'nemoguardrails.trustyai.opendatahub.io', 'c1-guardrail', '-n', NS, '-o', 'name')) throw new Error('NemoGuardrails not created');
await caption(page, 'Resources created. The TrustyAI operator now starts the guardrail server', 2500);

await fastForward(rec, page, 6);
for (let i = 0; i < 60; i++) {
  const pods = oc('get', 'pods', '-n', NS, '--no-headers');
  if (/2\/2\s+Running/.test(pods)) break;
  await caption(page, `Waiting for the guardrail server… ${Math.round((t0() - T0) / 1000)}s`, 0);
  await page.waitForTimeout(3000);
}
await normalSpeed(rec, page);
await page.goto(`${CONSOLE}/k8s/ns/${NS}/pods`, { waitUntil: 'domcontentloaded' });
await caption(page, `Guardrail server Running at ${Math.round((t0() - T0) / 1000)}s`, 3000);

// Live test with real calls
const host = oc('get', 'route', 'c1-guardrail', '-n', NS, '-o', 'jsonpath={.spec.host}');
const tok = oc('whoami', '-t');
const tests = ['Please email the statement to budi.santoso@example.com', 'My customer number is CIF-12345678',
  'Transfer to account 3171041208850123 today', 'What are your branch opening hours?'];
const rows = [];
const noauth = (await fetch(`https://${host}/v1/rails/configs`)).status;
for (const p of tests) {
  const r = await fetch(`https://${host}/v1/guardrail/checks`, { method: 'POST',
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: p }] }) });
  const j = await r.json();
  const by = Object.entries(j.rails_status || {}).filter(([, v]) => v.status === 'blocked').map(([k]) => k).join(', ');
  rows.push([p, j.status, by || '-']);
}
const secs = Math.round((t0() - T0) / 1000);
await page.setContent(`<html><body style="font-family:'Red Hat Text',Arial;margin:48px;background:#fafafa">
 <h2>C1 · New PII policy is live (${secs} s from empty project)</h2>
 <p style="font-size:18px">Endpoint https://${host}/v1/guardrail/checks · without a token: HTTP ${noauth}</p>
 <table style="font-size:20px;border-collapse:collapse" cellpadding="10" border="1"><tr><th>Prompt</th><th>Result</th><th>Rail</th></tr>
 ${rows.map(([p, s, b]) => `<tr><td>${p}</td><td style="font-weight:700;color:${s === 'blocked' ? '#c9190b' : '#3e8635'}">${s}</td><td>${b}</td></tr>`).join('')}
 </table><p style="font-size:18px">Created with: 1 console · 1 YAML template (2 analyst-editable lists) · 0 lines of code.
 Attach to a model by adding the model endpoint (see the production config aigov-guardrails with masking + Indonesian identifiers).</p></body></html>`);
await caption(page, `PII policy created and enforced in ${secs} s, without writing code`, 7000);
console.log(JSON.stringify({ seconds: secs, noauth, rows }));
await finish(rec, NAME);
