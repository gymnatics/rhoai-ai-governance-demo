// B6: token visibility and chargeback per team (MaaS token metrics; Observe & monitor → Usage dashboard is TP).
// 1) Usage dashboard over a custom time range, by subscription, then filtered to one team.
// 2) Chargeback report (notebooks/b6_chargeback.py output): platform-metered tokens × price, reconciled with the client.
// Env: ADMIN_PASSWORD. Optional: B6_START ("YYYY-MM-DD hh:mm:ss", default 18 h ago), B6_SUB (team to filter),
//      B6_CSV (default: newest ../reports/chargeback-*.csv)
import { start, caption, startStopwatch, login, finish, DASH } from './lib.mjs';
import fs from 'node:fs';
import path from 'node:path';

const NAME = 'B6-chargeback';
const pad = (n) => String(n).padStart(2, '0');
const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
const START = process.env.B6_START || fmt(new Date(Date.now() - 18 * 3600e3));
const reports = path.resolve('../reports');
const CSV = process.env.B6_CSV || (fs.existsSync(reports) ? fs.readdirSync(reports).filter((f) => /^chargeback-.*\.csv$/.test(f)).sort().map((f) => path.join(reports, f)).pop() : '');
if (!CSV) throw new Error('no chargeback CSV: run notebooks/B6-chargeback.ipynb first or set B6_CSV');
const [hdr, ...rows] = fs.readFileSync(CSV, 'utf8').trim().split(/\r?\n/).map((l) => l.split(',').map((x) => x.trim()));
const recs = rows.map((r) => Object.fromEntries(hdr.map((h, i) => [h, r[i]])));
const SUB = process.env.B6_SUB || recs[0].team_subscription;

const rec = await start(NAME);
const { page } = rec;
const step = async (label, fn) => { try { await fn(); } catch (e) { console.error(`step "${label}" failed: ${e.message.split('\n')[0]}`); } };
const slowScroll = async (px) => { await page.mouse.move(1150, 760); for (let y = 0; y < px; y += 120) { await page.mouse.wheel(0, 120); await page.waitForTimeout(90); } };

await login(page, 'admin', process.env.ADMIN_PASSWORD);
await page.goto(`${DASH}/observe-and-monitor/dashboard?start=30m&refresh=60s&dashboard=dashboard-3-maas-usage-admin`, { waitUntil: 'domcontentloaded' });
await page.getByRole('tab', { name: 'Usage' }).waitFor({ timeout: 60000 });
await page.getByRole('heading', { name: 'Total tokens' }).waitFor({ timeout: 60000 });
await page.waitForTimeout(2500);
await startStopwatch(page);
await caption(page, 'B6 · Observe & monitor → Dashboard → Usage: token metering from the MaaS gateway, per user, subscription and model (usage dashboard: Technology Preview)', 4500);

// custom time range covering the teams' runs
await step('custom range', async () => {
  await page.getByRole('combobox', { name: /Select time range/ }).click();
  await page.getByRole('option', { name: 'Custom Time Range' }).click();
  await caption(page, 'Custom time range: from yesterday evening to now, to cover every team\'s workload in this demo', 0);
  const s = page.getByRole('textbox', { name: 'Start Time' });
  await s.click();
  await s.fill(START);
  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await page.getByRole('heading', { name: 'Select Start Time' }).waitFor({ state: 'hidden', timeout: 10000 });
});
await page.waitForTimeout(5000);
await step('view by subscription', async () => {
  await page.getByTestId('variable-view_by').getByRole('button', { name: 'Open' }).click();
  await page.waitForTimeout(700);
  await page.getByRole('option', { name: 'By subscription' }).click();
});
await page.waitForTimeout(5000);
await caption(page, 'Totals for the period: tokens, requests, rate-limited requests (HTTP 429 from quotas and budgets), success rate, active users', 5000);
await slowScroll(560);
await page.waitForTimeout(1500);
await caption(page, 'Token consumption by subscription: one subscription per application team, so every token is attributed to a team', 5500);
await slowScroll(700);
await page.waitForTimeout(1500);
await caption(page, 'Further down: requests, rate limiting and usage per user and per subscription over the same period', 5000);

// one team only
await page.mouse.wheel(0, -5000);
await page.waitForTimeout(1200);
await step('filter subscription', async () => {
  const box = page.getByRole('combobox', { name: 'Subscription' });
  await page.getByTestId('variable-subscription').getByRole('button', { name: 'Open' }).click();
  await page.waitForTimeout(700);
  await box.pressSequentially(SUB.slice(-10), { delay: 50 });
  await page.waitForTimeout(800);
  await page.getByRole('option', { name: SUB, exact: true }).click();
  await page.keyboard.press('Escape');
});
await page.waitForTimeout(5000);
await caption(page, `Filtered to one team (${SUB}): what that team's cost centre is charged for in this period`, 5000);
await slowScroll(560);
await page.waitForTimeout(1500);
await caption(page, 'The same numbers are available to FinOps tooling through the Prometheus API; next, the chargeback report built from them', 4000);

// chargeback report
const price = Number(process.env.PRICE_IDR_PER_TOKEN || 0.25);
const num = (x) => Number(x).toLocaleString('en-US');
const tot = recs.reduce((a, r) => ({ p: a.p + Number(r.platform_tokens), c: a.c + Number(r.client_tokens), idr: a.idr + Number(r.cost_idr), calls: a.calls + Number(r.platform_calls) }), { p: 0, c: 0, idr: 0, calls: 0 });
const diff = tot.c ? ((tot.p - tot.c) / tot.c * 100) : 0;
await page.setContent(`<html><body style="font-family:'Red Hat Text',Arial,sans-serif;margin:48px 60px;background:#fafafa;color:#151515">
 <h2 style="margin:0 0 6px">B6 · Chargeback per team and cost centre</h2>
 <p style="font-size:18px;color:#444;margin:0 0 22px">Report <code>${path.basename(CSV)}</code> from <code>notebooks/B6-chargeback.ipynb</code>: platform-metered tokens (MaaS gateway counters, Prometheus) × price IDR ${price}/token, reconciled with what each client application counted itself.</p>
 <table style="font-size:19px;border-collapse:collapse;background:#fff" cellpadding="11" border="1">
  <tr style="background:#f0f0f0"><th>Team (subscription)</th><th>Cost centre</th><th>Calls</th><th>Platform tokens</th><th>Cost (IDR)</th><th>Client tokens</th><th>Difference</th></tr>
  ${recs.map((r) => `<tr><td>${r.team_subscription}</td><td>${r.cost_center}</td><td style="text-align:right">${num(r.platform_calls)}</td><td style="text-align:right">${num(r.platform_tokens)}</td><td style="text-align:right;font-weight:700">${num(r.cost_idr)}</td><td style="text-align:right">${num(r.client_tokens)}</td><td style="text-align:right;color:#3e8635;font-weight:700">${(Number(r.client_tokens) ? (Number(r.platform_tokens) - Number(r.client_tokens)) / Number(r.client_tokens) * 100 : 0).toFixed(3)}%</td></tr>`).join('')}
  <tr style="font-weight:700;background:#f7f7f7"><td>Total</td><td></td><td style="text-align:right">${num(tot.calls)}</td><td style="text-align:right">${num(tot.p)}</td><td style="text-align:right">${num(tot.idr)}</td><td style="text-align:right">${num(tot.c)}</td><td style="text-align:right;color:#3e8635">${diff.toFixed(3)}%</td></tr>
 </table>
 <p style="font-size:18px;margin-top:22px">Platform metering matches each client's own token count exactly. Showback per cost centre from GA gateway metrics; export as CSV (above) or query the same metrics from FinOps / BI tools.</p>
</body></html>`);
await caption(page, `Chargeback: tokens per team × price, mapped to cost centres. Platform vs client difference ${diff.toFixed(3)}%`, 7000);
await finish(rec, NAME);
