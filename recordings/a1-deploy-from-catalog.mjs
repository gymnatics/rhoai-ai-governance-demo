// A1: Deploy an open-source model from scratch (dashboard, model catalog) until the endpoint responds. Timed on screen.
// Env: ADMIN_PASSWORD. Precondition: project aigov-a1-live exists and is empty; a free L40S node.
import { start, caption, startStopwatch, login, oc, finish, fastForward, normalSpeed, DASH } from './lib.mjs';

const NAME = 'A1-deploy-from-catalog';
const NS = 'aigov-a1-live';
const RES = 'redhataiqwen3-8b-fp8-dynamic';
const rec = await start(NAME);
const { page } = rec;
const marks = {};
const t = () => ((Date.now() - marks.t0) / 1000).toFixed(0);

await login(page, process.env.ADMIN_USER || 'admin', process.env.ADMIN_PASSWORD);
await caption(page, 'A1 · Deploy an open-source model from scratch: Red Hat OpenShift AI 3.5 dashboard only', 3000);

await page.goto(`${DASH}/ai-hub/models/catalog`);
await startStopwatch(page); marks.t0 = Date.now();
await caption(page, 'Step 1 · AI hub → Models → Catalog: Red Hat validated models (provenance, licence, benchmarks)', 2500);
await page.getByRole('textbox', { name: 'Search with submit button' }).fill('Qwen3-8B-FP8');
await page.keyboard.press('Enter');
await caption(page, 'Step 2 · Search the catalog for the reference model: Qwen3-8B (FP8, Red Hat validated)', 1500);
await page.getByTestId('model-catalog-detail-link').first().click();
await caption(page, 'Step 3 · Model card: validated, tool calling, 8.2B params, minimum 10.9 GB vRAM, licence', 3000);
await page.getByRole('button', { name: 'Deploy model' }).click();

await caption(page, 'Step 4 · Choose the target project', 800);
await page.getByText('Select a project', { exact: true }).click();
await page.getByRole('menuitem', { name: 'AIGOV A1 live deploy' }).click();
await page.getByRole('button', { name: 'Next' }).click();
await caption(page, 'Step 5 · Model location is pre-filled from the catalog (registry.redhat.io modelcar). Nothing to type', 2500);
await page.getByRole('button', { name: 'Next' }).click();

await caption(page, 'Step 6 · Deployment: LLM inference service, GPU hardware profile, vLLM NVIDIA CUDA single-node runtime', 1500);
await page.getByText('default-profile', { exact: true }).first().click();
await page.getByRole('option', { name: /^gpu-profile/ }).click();
await page.getByTestId('serving-runtime-template-selection-toggle').click();
await page.getByTestId('servingRuntime v3-5-2-kserve-config-llm-single-node-template-nvidia-cuda')
  .getByRole('menuitem', { name: /vLLM NVIDIA CUDA GPU/ }).click();
await page.waitForTimeout(1200);
await page.getByRole('button', { name: 'Next' }).click();

await caption(page, 'Step 7 · Advanced settings: token authentication is on by default; optional MaaS publishing', 2500);
await page.getByRole('button', { name: 'Next' }).click();
await caption(page, 'Step 8 · Review, then deploy', 2500);
await page.getByRole('button', { name: 'Deploy model' }).last().click();
marks.deployClick = Date.now();
await caption(page, `Deploy submitted at ${t()}s. OpenShift AI pulls the validated modelcar and starts vLLM on an NVIDIA L40S`, 2000);

// Fail fast if the wizard shows an error (run scripts/a1-reset.sh between rehearsals)
await page.waitForTimeout(3000);
const err = page.getByText(/already exists|Error creating|failed/i).first();
if (await err.isVisible().catch(() => false)) throw new Error('Deploy wizard error: ' + (await err.textContent()));
await fastForward(rec, page, 10);   // image pull + weights load + vLLM warm-up: shown 10x faster, stopwatch stays real time
// Wait for the dashboard to create the LLMInferenceService (async after submit)
for (let i = 0; i < 90 && !oc('get', 'llminferenceservice', RES, '-n', NS, '-o', 'name'); i++) await page.waitForTimeout(2000);
if (!oc('get', 'llminferenceservice', RES, '-n', NS, '-o', 'name')) throw new Error('LLMInferenceService not created within 180s of Deploy');
// Wait for Ready (time-lapsed in the edited video), refreshing the deployments view
for (let i = 0; i < 90; i++) {
  const ready = oc('get', 'llminferenceservice', RES, '-n', NS, '-o', 'jsonpath={.status.conditions[?(@.type=="Ready")].status}').includes('True');
  if (ready) break;
  await caption(page, `Waiting for the model server… ${t()}s (image pull + weights load + vLLM warm-up)`, 0);
  await page.waitForTimeout(10000);
  if (i % 3 === 2) await page.reload().catch(() => {});
}
marks.ready = Date.now();
await normalSpeed(rec, page);
await page.reload().catch(() => {});
await caption(page, `Model deployment Ready at ${t()}s`, 3000);

// First request with the generated token (token-authenticated endpoint)
const url = oc('get', 'llminferenceservice', RES, '-n', NS, '-o', 'jsonpath={.status.url}');
const sa = oc('get', 'sa', '-n', NS, '-o', 'name').split('\n').map((s) => s.replace('serviceaccount/', ''))
  .find((s) => s.includes(RES) || s.includes('default-name')) || 'default';
const token = oc('create', 'token', sa, '-n', NS, '--duration=1h');
const body = { model: RES, max_tokens: 200, chat_template_kwargs: { enable_thinking: false }, messages: [{ role: 'user', content: 'In one sentence, what is Acme Bank?' }] };
const res = await fetch(`${url}/v1/chat/completions`, {
  method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const json = await res.json();
marks.first = Date.now();
const answer = (json.choices?.[0]?.message?.content || JSON.stringify(json)).replace(/<think>[\s\S]*?<\/think>/g, '').trim();
const unauth = (await fetch(`${url}/v1/models`)).status;
await page.setContent(`<html><body style="font-family:'Red Hat Text',Arial;margin:48px;background:#fafafa">
  <h2>A1 · First response from the newly deployed endpoint</h2>
  <p><b>Endpoint:</b> ${url}/v1/chat/completions (OpenAI-compatible)</p>
  <p><b>Without token:</b> HTTP ${unauth} &nbsp;·&nbsp; <b>With generated token:</b> HTTP ${res.status}</p>
  <pre style="background:#151515;color:#9ee09e;padding:20px;border-radius:8px;white-space:pre-wrap;font-size:18px">$ curl -H "Authorization: Bearer $TOKEN" ${url}/v1/chat/completions \\
  -d '{"model":"${RES}","chat_template_kwargs":{"enable_thinking":false},
       "messages":[{"role":"user","content":"In one sentence, what is Acme Bank?"}]}'

${answer.replace(/</g, '&lt;')}</pre>
  <table style="font-size:20px;border-collapse:collapse" cellpadding="8">
   <tr><td>Deploy clicked</td><td><b>${((marks.deployClick - marks.t0) / 1000).toFixed(0)} s</b> after opening the catalog</td></tr>
   <tr><td>Endpoint Ready</td><td><b>${((marks.ready - marks.t0) / 1000).toFixed(0)} s</b></td></tr>
   <tr><td>First response</td><td><b>${((marks.first - marks.t0) / 1000).toFixed(0)} s</b> (${((marks.first - marks.t0) / 60000).toFixed(1)} min)</td></tr>
   <tr><td>Consoles used</td><td>1 (OpenShift AI dashboard) + 1 HTTP client</td></tr></table></body></html>`);
await caption(page, `First response at ${t()}s: one console, no YAML, validated model from the catalog`, 7000);
console.log(JSON.stringify({ deploy_click_s: (marks.deployClick - marks.t0) / 1000, ready_s: (marks.ready - marks.t0) / 1000,
  first_response_s: (marks.first - marks.t0) / 1000, unauth_status: unauth, auth_status: res.status }));
await finish(rec, NAME);
