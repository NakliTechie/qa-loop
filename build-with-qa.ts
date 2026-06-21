// build-with-qa.ts
// A text-only coding agent (writes HTML) paired with a multimodal QA agent
// (looks at a rendered screenshot) in a generate -> render -> critique -> repair loop.
//
//   npm install && npx playwright install chromium
//   npm run build -- "a landing page for a coffee subscription"
//
// Models are OpenAI-compatible. Defaults route through OpenRouter:
//   coder = z-ai/glm-5.2 (text-only)   QA = qwen/qwen3-vl-235b-a22b-instruct (vision)
// Swap CODER_URL / QA_URL to a self-hosted vLLM/SGLang endpoint to run fully on your own GPUs.

import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const CODER = {
  baseUrl: process.env.CODER_URL ?? 'https://openrouter.ai/api/v1',
  model: process.env.CODER_MODEL ?? 'z-ai/glm-5.2',
  key: process.env.CODER_KEY ?? process.env.OPENAI_API_KEY!,
};
const QA = {
  baseUrl: process.env.QA_URL ?? 'https://openrouter.ai/api/v1',
  model: process.env.QA_MODEL ?? 'qwen/qwen3-vl-235b-a22b-instruct',
  key: process.env.QA_KEY ?? process.env.OPENAI_API_KEY!,
};

// ---- 1. Render + screenshot (mirrors the Playwright capture playbook) --------
async function renderAndShoot(html: string) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.setContent(html, { waitUntil: 'networkidle', timeout: 60_000 }).catch(() => {});
  // Walk down the page to trip scroll-reveal IntersectionObservers / lazy loads.
  await page.evaluate(async () => {
    await new Promise<void>((res) => {
      let y = 0; const step = Math.max(200, window.innerHeight * 0.8);
      const t = setInterval(() => {
        window.scrollTo(0, y); y += step;
        if (y >= document.body.scrollHeight) { clearInterval(t); window.scrollTo(0, 0); res(); }
      }, 80);
    });
  }).catch(() => {});
  // Force-reveal: neutralize "hidden until scrolled" so the QA screenshot sees ALL built content.
  // (Without this, fullPage captures scroll-animated sections at opacity:0 — they read as "missing".)
  await page.addStyleTag({ content: `*,*::before,*::after{opacity:1!important;transform:none!important;animation:none!important;transition:none!important;visibility:visible!important;filter:none!important}` }).catch(() => {});
  await page.evaluate(() => window.dispatchEvent(new Event('resize'))).catch(() => {});   // nudge responsive chart.js to redraw at real size
  await page.evaluate(async () => { if (document.fonts) await document.fonts.ready; }).catch(() => {});
  await page.waitForTimeout(1_500);
  const buf = await page.screenshot({ type: 'png', fullPage: true });
  await browser.close();
  return { png: buf.toString('base64'), bytes: buf.length, raw: buf };
}

// ---- 2. The text-only coder (lessons from the GLM-5.2 teardown baked in) -----
const CODER_SYS = `You generate a SINGLE self-contained HTML file (inline <style>/<script>, CDN deps allowed).
Hard-won rules:
- Use TailwindCSS (play CDN) for layout; font-awesome for icons. Style everything — never ship raw HTML.
- Prefer proven, "expert template" structures over novel experiments. Nail the above-the-fold hero.
- If you use chart.js / three.js, wire them correctly so they ACTUALLY render (init after DOM, real data).
- Use real external CDN images (e.g. images.unsplash.com) instead of hand-building visuals or empty boxes.
- NO purple gradients, no generic-AI aesthetic. Tasteful, specific, modern.
- Aim ~46K-57K characters of output. Detailed, but stop once complete — extra length has diminishing returns.
- Keep internal planning brief — spend the token budget on the complete HTML, not lengthy reasoning.
Return ONLY the HTML, starting with <!doctype html>.`;

async function generateSite(prompt: string, feedback?: string) {
  const messages: any[] = [
    { role: 'system', content: CODER_SYS },
    { role: 'user', content: prompt },
  ];
  if (feedback) messages.push({
    role: 'user',
    content: `Your previous attempt had these QA defects. Fix ALL of them and return the full HTML again:\n${feedback}`,
  });
  return stripToHtml(await chat(CODER, { messages, temperature: 0.7, max_tokens: Number(process.env.CODER_MAXTOK ?? 6_500) }));
}

// ---- 2b. Patch mode: fix the prior HTML in place, don't regenerate from scratch ----
const PATCH_SYS = `You are FIXING an existing HTML page. You get the current full HTML plus a numbered list of fixes from a visual QA review of its rendered screenshot.
Rules:
- Apply EVERY fix.
- Change ONLY what the fixes require. Preserve all other markup, copy, styling, scripts, and structure EXACTLY — do NOT drop or restyle sections that already work.
- If a fix says a chart/widget didn't render, ADD the real initialization JS (e.g. an actual new Chart(...) call wired to the existing canvas) — not just the library include.
- Keep Tailwind + real CDN images; no purple gradients.
Return the COMPLETE corrected HTML file, starting with <!doctype html>. Output ONLY the HTML.`;

async function patchSite(prompt: string, prevHtml: string, fixes: string) {
  const messages: any[] = [
    { role: 'system', content: PATCH_SYS },
    { role: 'user', content: `Original request (context): ${prompt}\n\nFixes to apply:\n${fixes}\n\nCURRENT HTML — return the full corrected version:\n\n${prevHtml}` },
  ];
  return stripToHtml(await chat(CODER, { messages, temperature: 0.4, max_tokens: Number(process.env.CODER_MAXTOK ?? 6_500) }));
}

// ---- 3. The multimodal QA agent (checklist = the article's error cases) ------
const QA_SYS = `You are a strict visual QA reviewer for generated web pages. You are shown a full-page screenshot.
Judge ONLY what you can see. Check, in order:
1 RENDERS: page is not blank/white, not an error, content is visible.
2 STYLED: real CSS applied (not unstyled default HTML).
3 LAYOUT: above-the-fold hero is composed; no overlapping/clipped/overflowing elements; aligned.
4 IMAGES: images actually loaded (no broken-image icons, no empty placeholder boxes).
5 WIDGETS: any chart/3D/map actually rendered (not a blank canvas).
6 TASTE: no purple-gradient / generic-AI look; typography and spacing are intentional.
7 FIDELITY: the page matches the user's request.
Return ONLY JSON (no prose, no code fences):
{"pass": true|false,
 "scores": {"renders":0-5,"styled":0-5,"layout":0-5,"images":0-5,"widgets":0-5,"taste":0-5,"fidelity":0-5},
 "defects": [{"severity":"blocker|major|minor","category":"...","what":"what is visually wrong",
              "fix_instruction":"the concrete code-level change — which element/section to add or edit and how, e.g. \\"Add a <script> after the #flavorChart canvas that calls new Chart(...) of type bar with the four flavor values.\\" Do NOT merely restate the problem."}]}
Set pass=false if ANY blocker exists or any score <= 2.`;

interface QAReport {
  pass: boolean;
  scores: Record<string, number>;
  defects: { severity: string; category: string; what: string; fix_instruction: string }[];
}

async function qaScreenshot(pngB64: string, prompt: string): Promise<QAReport> {
  const out = await chat(QA, {
    temperature: 0,
    max_tokens: Number(process.env.QA_MAXTOK ?? 700),
    messages: [
      { role: 'system', content: QA_SYS },
      { role: 'user', content: [
        { type: 'text', text: `User asked for: ${prompt}` },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${pngB64}` } },
      ]},
    ],
  });
  return JSON.parse(extractJson(out)) as QAReport;
}

// ---- 4. The loop ------------------------------------------------------------
async function buildWithQA(prompt: string, maxRounds = Number(process.env.MAXROUNDS ?? 3)) {
  let fixes: string | undefined;             // actionable fix list from the last QA pass
  let prevHtml: string | undefined;          // last non-blank HTML, the thing we patch
  let last: { html: string; report: QAReport } | undefined;
  for (let round = 1; round <= maxRounds; round++) {
    try {
      const t0 = Date.now();
      const mode = prevHtml && fixes ? 'patch' : 'scratch';
      log(`round ${round}: ${mode} generate with ${CODER.model}...`);
      const html = mode === 'patch'
        ? await patchSite(prompt, prevHtml!, fixes!)
        : await generateSite(prompt);
      log(`round ${round}: ${html.length} chars in ${secs(t0)}s. rendering...`);

      const { png, bytes, raw } = await renderAndShoot(html);
      writeFileSync(`round-${round}.png`, raw);
      writeFileSync(`round-${round}.html`, html);

      if (bytes < 12_000) {                                    // blank-capture guard
        log(`round ${round}: BLANK (${bytes}B). regenerating from scratch next round.`);
        prevHtml = undefined; fixes = undefined;               // never patch a blank
        last = { html, report: { pass: false, scores: { renders: 0 }, defects: [] } };
        continue;
      }

      log(`round ${round}: QA with ${QA.model}...`);
      const report = await qaScreenshot(png, prompt);
      writeFileSync(`report-${round}.json`, JSON.stringify(report, null, 2));
      last = { html, report };
      log(`round ${round}: pass=${report.pass} scores=${JSON.stringify(report.scores)} defects=${report.defects.length}`);
      for (const d of report.defects) log(`   - [${d.severity}] ${d.category}: ${d.what}`);

      if (report.pass) return { ...last, rounds: round };
      prevHtml = html;                                         // patch THIS page next round
      fixes = report.defects
        .map((d, i) => `${i + 1}. [${d.severity}] ${d.fix_instruction || d.what}`)
        .join('\n');
    } catch (e: any) {
      log(`round ${round}: error — ${String(e.message).slice(0, 220)}`);
      if (last) { log('stopping early; returning last good round.'); break; }
      throw e;                                                // round 1 itself failed — nothing to return
    }
  }
  return { ...last!, rounds: maxRounds };
}

// ---- helpers ----------------------------------------------------------------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Streaming chat — keeps the connection alive through GLM-5.2's ~300s generations
// (a non-streaming request sits idle past the gateway timeout and gets dropped),
// with transient-failure retries per the seed-script playbook.
async function chat(cfg: { baseUrl: string; model: string; key: string }, body: any, attempt = 1): Promise<string> {
  try {
    const r = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.key}`, 'X-Title': 'qa-loop' },
      body: JSON.stringify({ model: cfg.model, ...body, stream: true }),
    });
    if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}: ${r.ok ? 'no body' : (await r.text()).slice(0, 300)}`);
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '', content = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop() ?? '';
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const data = t.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try { const d = JSON.parse(data).choices?.[0]?.delta?.content; if (d) content += d; } catch { /* keep-alive / partial */ }
      }
    }
    if (!content) throw new Error('empty stream');
    return content;
  } catch (e: any) {
    const m = String(e.message);
    const nonRetryable = / 4\d\d:/.test(m) && !/ 429:/.test(m);   // 4xx (except 429) = our fault, don't retry
    if (attempt < 4 && !nonRetryable) {
      log(`  ${cfg.model}: ${m.slice(0, 90)} — retry ${attempt}/3`);
      await sleep(2500 * attempt);
      return chat(cfg, body, attempt + 1);
    }
    throw new Error(`${cfg.model} ${m}`);
  }
}
const stripToHtml = (s: string) => {
  const m = s.match(/<!doctype html[\s\S]*<\/html>/i) || s.match(/```html?\n([\s\S]*?)```/i);
  return m ? (m[1] ?? m[0]) : s;
};
const extractJson = (s: string) => { const m = s.match(/\{[\s\S]*\}/); return m ? m[0] : s; };
const secs = (t0: number) => ((Date.now() - t0) / 1000).toFixed(0);
const log = (m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

// ---- run --------------------------------------------------------------------
const prompt = process.argv[2] ?? 'a landing page for a specialty coffee subscription';
log(`prompt: ${prompt}`);
buildWithQA(prompt)
  .then(r => {
    writeFileSync('out.html', r.html);
    log(`DONE in ${r.rounds} round(s) -> out.html  (final pass=${r.report.pass})`);
  })
  .catch(e => { log(`FAILED: ${e.message}`); process.exit(1); });
