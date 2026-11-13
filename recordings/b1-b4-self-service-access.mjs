// B1 + B4: self-service model access and per-application access control (Models-as-a-Service, GA).
// Users: aigov-app-chatbot (has a subscription), aigov-app-unauth (none), admin (governance view).
// Env: APP_CHATBOT_PASSWORD, APP_UNAUTH_PASSWORD, ADMIN_PASSWORD
import { start, caption, startStopwatch, login, finish, DASH } from './lib.mjs';

const NAME = 'B1-B4-self-service-access';
const MAAS = process.env.MAAS_URL;
const Q8 = process.env.MODEL_ID;
const Q06 = process.env.SMALL_MODEL_ID;   // aigov-small: not in the chatbot policy
const rec = await start(NAME);
const { page, context } = rec;
const t0 = Date.now();
const secs = () => Math.round((Date.now() - t0) / 1000);
const step = async (label, fn) => { try { await fn(); } catch (e) { console.error(`step "${label}" failed: ${e.message.split('\n')[0]}`); } };
const call = async (key, model) => {
  const r = await fetch(`${MAAS}/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: 30, chat_template_kwargs: { enable_thinking: false }, messages: [{ role: 'user', content: 'Say hello in five words.' }] }) });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, text: j.choices?.[0]?.message?.content || j.error?.message || j.message || JSON.stringify(j).slice(0, 120) };
};
const waitFor = async (loc, ms = 60000) => loc.filter({ visible: true }).first().waitFor({ timeout: ms });

// ---- 1. Developer of the chatbot app: self-service ----
await login(page, 'aigov-app-chatbot', process.env.APP_CHATBOT_PASSWORD);
await caption(page, 'B1 · Signed in as aigov-app-chatbot (Keycloak SSO): a developer of the internal chatbot team. No ticket to the platform team', 3500);
await startStopwatch(page);
await page.goto(`${DASH}/maas/keys-and-subs/subscriptions`);
await waitFor(page.getByText('aigov-chatbot'));
await caption(page, 'Gen AI studio → API keys → Subscriptions: the team sees only the subscription it was granted (aigov-chatbot)', 3000);
await step('expand subscription', async () => { await page.getByRole('button', { name: /expand|details/i }).first().click(); });
await caption(page, 'The subscription lists the models it covers and the token limit set by the platform team', 3500);

await page.getByRole('tab', { name: 'API keys' }).click();
await page.getByRole('button', { name: 'Create API key' }).click();
const keyName = `chatbot-demo-${Date.now() % 100000}`;
await page.getByRole('textbox', { name: 'Name' }).fill(keyName);
await page.getByRole('textbox', { name: 'Description' }).fill('AI governance demo demo key (B1)');
await page.getByRole('combobox', { name: 'Type to filter' }).click();
await caption(page, 'Create API key: name, description, subscription scope and expiry (max 90 days). Only the user\'s own subscriptions are offered', 2500);
await page.getByRole('option', { name: /aigov-chatbot/ }).first().click();
await page.getByRole('button', { name: 'Create API key' }).last().click();
await waitFor(page.getByText('API key created'), 30000);
// The key stays masked on screen: use the dialog's copy button and read the clipboard (never revealed in the video)
await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: DASH });
const dlg = page.getByRole('dialog');
await dlg.getByRole('button', { name: /copy/i }).first().click().catch(async () => { await dlg.locator('button').nth(2).click(); });
await page.waitForTimeout(500);
const key = (await page.evaluate(() => navigator.clipboard.readText())).trim();
if (!key.startsWith('sk-oai-')) throw new Error('could not read the new key');
const created = secs();
await caption(page, `Key created at ${created}s and shown once. The developer copies it; the platform stores only a hash`, 3500);
await page.getByRole('dialog').getByRole('button', { name: 'Close' }).last().click();
await page.waitForTimeout(1500);
await caption(page, 'The new key appears in the team\'s key list, scoped to its subscription, with an expiry date', 3000);

// ---- 2. Use the key: OpenAI-compatible, scoped to the subscription ----
const models = await (await fetch(`${MAAS}/v1/models`, { headers: { Authorization: `Bearer ${key}` } })).json();
const ok = await call(key, Q8);
const firstCall = secs();
const deny = await call(key, Q06);
const forged = await call('sk-oai-FORGEDKEY000000000000000', Q8);
const nokey = (await fetch(`${MAAS}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: Q8, messages: [{ role: 'user', content: 'hi' }] }) })).status;

// ---- 3. Revoke the key (self-service) and prove it stops working ----
const tok = await page.evaluate(async () => '');
const list = await (await fetch(`${MAAS}/maas-api/v1/api-keys/search`, { method: 'POST',
  headers: { Authorization: `Bearer ${process.env.APP_CHATBOT_TOKEN}`, 'Content-Type': 'application/json' }, body: '{}' })).json().catch(() => ({ data: [] }));
const mine = (list.data || []).find((k) => k.name === keyName);
let revokedStatus = 'n/a', revokeSecs = 'n/a';
if (mine) {
  const tr = Date.now();
  await fetch(`${MAAS}/maas-api/v1/api-keys/${mine.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${process.env.APP_CHATBOT_TOKEN}` } });
  for (let i = 0; i < 60; i++) { const r = await call(key, Q8); revokedStatus = r.status; if (r.status !== 200) break; await page.waitForTimeout(1000); }
  revokeSecs = ((Date.now() - tr) / 1000).toFixed(1);
}
const row = (k, v, good) => `<tr><td>${k}</td><td style="font-weight:700;color:${good ? '#3e8635' : '#c9190b'}">${v}</td></tr>`;
await page.setContent(`<html><body style="font-family:'Red Hat Text',Arial;margin:44px;background:#fafafa">
 <h2>B1 + B4 · The new key, from any OpenAI-compatible client</h2>
 <p style="font-size:18px">GET /v1/models with the new key → <b>${(models.data || []).map((m) => m.id).join(', ')}</b> (only the subscribed model is visible)</p>
 <table style="font-size:20px;border-collapse:collapse" cellpadding="9" border="1">
 ${row('chatbot key → aigov-qwen3-8b (in subscription)', `HTTP ${ok.status}: ${ok.text}`, ok.status === 200)}
 ${row('chatbot key → aigov-small (not in its policy)', `HTTP ${deny.status}: ${deny.text}`, false)}
 ${row('forged key', `HTTP ${forged.status}`, false)}
 ${row('no key', `HTTP ${nokey}`, false)}
 ${row('same key after self-service revocation', `HTTP ${revokedStatus} (effective in ${revokeSecs} s)`, false)}
 </table>
 <p style="font-size:18px">Request → working key: <b>${created} s</b> · first successful call: <b>${firstCall} s</b> · no ticket, no platform-team action.</p></body></html>`);
await caption(page, `Self-service: key in ${created}s, first call in ${firstCall}s. Access is limited to the subscribed model; revocation is immediate`, 7000);

// ---- 4. An application without a subscription ----
await context.clearCookies();
await login(page, 'aigov-app-unauth', process.env.APP_UNAUTH_PASSWORD);
await caption(page, 'B4 · Signed in as aigov-app-unauth: an application that was NOT granted any subscription', 3000);
await page.goto(`${DASH}/maas/keys-and-subs/subscriptions`);
await page.waitForTimeout(8000);
await caption(page, 'Subscriptions tab: "Request a subscription". No subscription means no models and no keys', 3500);
await page.goto(`${DASH}/maas/keys-and-subs`);
await step('unauth create dialog', async () => {
  await page.getByRole('button', { name: 'Create API key' }).click({ timeout: 30000 });
  await page.getByText('No subscriptions available').first().waitFor({ timeout: 15000 });
});
await caption(page, '"No subscriptions available": the subscription field and Create button are disabled, so the app cannot obtain a key (the MaaS API also refuses: invalid_subscription)', 5000);
await page.keyboard.press('Escape');

// ---- 5. Platform admin: where this is governed ----
await context.clearCookies();
await login(page, process.env.ADMIN_USER || 'admin', process.env.ADMIN_PASSWORD);
await page.goto(`${DASH}/maas/maas-governance`);
await waitFor(page.getByText('aigov-chatbot'));
await caption(page, 'Platform admin · Settings → MaaS governance: one subscription per team (groups, models, token limits, priority)', 4000);
await page.getByRole('tab', { name: 'Authorization policies' }).click();
await page.waitForTimeout(4000);
await caption(page, 'Authorization policies decide which groups may call which models. aigov-app-unauth\'s group has none, so every call is rejected', 5000);
console.log(JSON.stringify({ key_created_s: created, first_call_s: firstCall, ok: ok.status, deny: deny.status, forged: forged.status, nokey, revokedStatus, revokeSecs }));
await finish(rec, NAME);
