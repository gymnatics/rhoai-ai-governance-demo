// B7: Budget limits with alerts (80%) and cut-off (100%).
// Split screen: left = live terminal of the app consuming tokens (notebooks/b7_budget.py, B7_VERBOSE=1),
// right = the team's alert inbox (Alertmanager webhook receiver). Waiting stretches are fast-forwarded (badge on screen).
// Env: ADMIN_PASSWORD, plus the b7_budget.py env (MAAS_URL, KEY_COLLECTIONS, PROM_URL, PROM_TOKEN, RECEIVER_URL).
import { start, caption, login, finish, startStopwatch, fastForward, normalSpeed, injectOverlay, oc, CONSOLE } from './lib.mjs';
import { spawn } from 'node:child_process';
import path from 'node:path';

const NAME = 'B7-budget-alert';
const RECEIVER = process.env.RECEIVER_URL;
const INBOX = `${RECEIVER}/?team=${encodeURIComponent(process.env.B7_SUBSCRIPTION || 'aigov-collections')}`;
// fresh receiver page (in-memory history) for a clean recording
oc('rollout', 'restart', 'deploy/aigov-alert-receiver', '-n', process.env.DEMO_NS);
oc('rollout', 'status', 'deploy/aigov-alert-receiver', '-n', process.env.DEMO_NS, '--timeout=120s');
const rec = await start(NAME);
const { page } = rec;

const term = [];
let onSplit = false;
const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const render = async () => {
  if (!onSplit) return;
  await page.evaluate((h) => { const el = document.getElementById('term'); if (el) { el.innerHTML = h; el.scrollTop = el.scrollHeight; } },
    term.slice(-34).map((l) => (l.startsWith('$') ? `<span style="color:#7cc4ff">${esc(l)}</span>`
      : /429|TeamBudget|cut-off/.test(l) ? `<span style="color:#ffb3b3;font-weight:700">${esc(l)}</span>` : esc(l))).join('\n')).catch(() => {});
};
const reloadInbox = () => page.evaluate(() => { const f = document.getElementById('inbox'); if (f) f.src = f.src; }).catch(() => {});
const showSplit = async (title) => {
  // base the split page on the receiver's JSON endpoint: the HTML page has a 5 s meta-refresh that would replace it
  await page.goto(`${RECEIVER}/api`);
  await page.setContent(`<html><body style="margin:0;font-family:'Red Hat Text',Arial,sans-serif;background:#f2f2f2">
    <div style="position:fixed;left:0;right:0;top:0;height:64px;background:#fff;border-bottom:1px solid #ddd;display:flex;align-items:center;padding-left:24px;font-weight:700;font-size:21px">${title}</div>
    <div style="position:fixed;left:16px;top:80px;width:calc(56% - 24px);height:28px;font:600 15px monospace;color:#555">terminal · application of team "collections" calling the MaaS endpoint</div>
    <pre id="term" style="position:fixed;left:16px;top:108px;height:calc(100vh - 178px);box-sizing:border-box;width:calc(56% - 24px);margin:0;background:#151515;color:#c8f7c5;font:15px/1.45 'Red Hat Mono',Menlo,monospace;padding:16px;border-radius:8px;overflow:hidden;white-space:pre-wrap"></pre>
    <div style="position:fixed;right:16px;top:80px;width:calc(44% - 24px);height:28px;font:600 15px monospace;color:#555">team alert inbox · Alertmanager webhook receiver</div>
    <iframe id="inbox" src="${INBOX}" style="position:fixed;right:16px;top:108px;height:calc(100vh - 178px);box-sizing:border-box;width:calc(44% - 24px);border:1px solid #ccc;border-radius:8px;background:#fff"></iframe>
  </body></html>`);
  onSplit = true;
  await injectOverlay(page);
  await render();
};

await login(page, process.env.ADMIN_USER || 'admin', process.env.ADMIN_PASSWORD, CONSOLE);
await showSplit('B7 · Team budget with alert at 80% and cut-off at 100%');
await startStopwatch(page);
await caption(page, 'Team "collections" has a token budget of 20,000 tokens per hour (demo window; production = monthly), IDR 0.25/token', 4000);
await caption(page, '80% → TeamBudget80 (PrometheusRule on Limitador token metrics → Alertmanager) · 100% → MaaS cuts the team off with HTTP 429', 4000);

const py = spawn('python3', ['-I', '-u', path.resolve('../notebooks/b7_budget.py')], { env: { ...process.env, B7_VERBOSE: '1' } });
let log = '';
py.stdout.on('data', (d) => {
  for (const l of d.toString().split('\n').filter((x) => x.trim())) { log += l + '\n'; term.push(l); console.log('[b7]', l); }
  render();
});
py.stderr.on('data', (d) => console.error('[b7 err]', d.toString()));
const until = async (re, ms) => { for (let t = 0; t < ms && !re.test(log); t += 1000) await page.waitForTimeout(1000); };

// Phase A: consume to 80%
await caption(page, 'The team\'s application sends requests; every response carries usage.total_tokens, which MaaS meters per subscription', 0);
await page.waitForTimeout(6000);
await fastForward(rec, page, 4);
await until(/client tokens sent/, 240000);
await caption(page, 'Budget passed 80%. Waiting for the alert rule to evaluate and Alertmanager to deliver it', 0);
await fastForward(rec, page, 8);
await until(/TeamBudget80 received/, 420000);
await normalSpeed(rec, page);
await reloadInbox();
await caption(page, 'TeamBudget80 delivered to the team inbox (stands in for e-mail / Slack / ITSM)', 5000);

// Same alert in the OpenShift console (Phase B keeps running in the background; its lines appear when we return)
onSplit = false;
// label filter needs key=value (a bare alert name matches nothing); the alert list loads slowly, so wait for the row
await page.goto(`${CONSOLE}/monitoring/alerts?rowFilter-alert-source=user&alerts=alertname%3DTeamBudget80`, { waitUntil: 'domcontentloaded' });
await page.locator('table tbody tr', { hasText: 'TeamBudget80' }).first().waitFor({ timeout: 60000 }).catch(() => console.error('alert row not shown in console'));
await page.waitForTimeout(1500);
await caption(page, 'The same alert in OpenShift console → Observe → Alerting (user-defined alert, source: user)', 5000);

// Phase B: to 100% -> 429, then the 100% alert
await showSplit('B7 · Team budget with alert at 80% and cut-off at 100%');
await caption(page, 'The application keeps sending until the budget is exhausted', 0);
await fastForward(rec, page, 4);
await until(/cut-off/, 300000);
await normalSpeed(rec, page);
await page.waitForTimeout(1500);
await caption(page, 'Cut-off: at 100% of the budget MaaS returns HTTP 429. Retries are rejected too', 5000);
await caption(page, 'Waiting for TeamBudget100', 0);
await fastForward(rec, page, 8);
await until(/TeamBudget100 received/, 420000);
await normalSpeed(rec, page);
await reloadInbox();
await page.waitForTimeout(2500);
await caption(page, 'TeamBudget100 (critical) delivered. Alert at 80%, enforced cut-off at 100%, from GA parts (MaaS token limits + OpenShift alerting)', 7000);
py.kill();
await finish(rec, NAME);
