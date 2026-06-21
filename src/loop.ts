// src/loop.ts — the engine.
// A text-only coder + multimodal vision critic in a generate→render→critique→repair loop.
// Pure: runLoop() does no file IO — it returns html, the final report, per-round screenshots, and metrics.
import { chromium, type Browser } from 'playwright';
import { loadTaste } from './taste.ts';

export interface ModelCfg { baseUrl: string; model: string; key: string; maxTok: number; }
export interface RunConfig {
  coder: ModelCfg;
  critic: ModelCfg;
  cheapCritic?: ModelCfg | null;     // if set: screen with this, escalate to `critic` unless it's a confident fail
  maxRounds: number;
  viewport?: { width: number; height: number };
  log?: (m: string) => void;
}
export interface Defect { severity: string; category: string; what: string; fix_instruction: string; }
export interface QAReport { pass: boolean; scores: Record<string, number>; defects: Defect[]; }
export interface RoundInfo {
  round: number; mode: 'scratch' | 'patch'; genMs: number; qaMs: number;
  chars: number; pass: boolean; scores: Record<string, number>; defects: number; criticModel: string;
}
export interface Usage { coderIn: number; coderOut: number; criticIn: number; criticOut: number; }
export interface RunResult {
  prompt: string; passed: boolean; rounds: number; html: string; report: QAReport;
  totalMs: number; perRound: RoundInfo[]; usage: Usage;
  shots: { round: number; jpg: Buffer }[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();

// ---- streaming OpenAI-compatible client (survives ~300s generations) --------
async function chat(cfg: ModelCfg, messages: any[], temperature: number, attempt = 1): Promise<{ content: string; inTok: number; outTok: number }> {
  try {
    const r = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.key}`, 'X-Title': 'qa-loop' },
      body: JSON.stringify({ model: cfg.model, messages, temperature, max_tokens: cfg.maxTok, stream: true, stream_options: { include_usage: true } }),
    });
    if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}: ${r.ok ? 'no body' : (await r.text()).slice(0, 300)}`);
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '', content = '', inTok = 0, outTok = 0;
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
        try {
          const j = JSON.parse(data);
          const d = j.choices?.[0]?.delta?.content; if (d) content += d;
          if (j.usage) { inTok = j.usage.prompt_tokens ?? inTok; outTok = j.usage.completion_tokens ?? outTok; }
        } catch { /* keep-alive / partial frame */ }
      }
    }
    if (!content) throw new Error('empty stream');
    return { content, inTok, outTok };
  } catch (e: any) {
    const m = String(e.message);
    const nonRetryable = / 4\d\d:/.test(m) && !/ 429:/.test(m);
    if (attempt < 4 && !nonRetryable) { await sleep(2500 * attempt); return chat(cfg, messages, temperature, attempt + 1); }
    throw new Error(`${cfg.model} ${m}`);
  }
}

// ---- render + screenshot (reveals scroll-animated content before capture) ----
export async function renderAndShoot(html: string, viewport = { width: 1440, height: 900 }, browser?: Browser) {
  const b = browser ?? (await chromium.launch());
  const page = await b.newPage({ viewport });
  try {
    await page.setContent(html, { waitUntil: 'networkidle', timeout: 60_000 }).catch(() => {});
    await page.evaluate(async () => {                                   // walk down to trip IntersectionObservers
      await new Promise<void>((res) => {
        let y = 0; const step = Math.max(200, window.innerHeight * 0.8);
        const t = setInterval(() => {
          window.scrollTo(0, y); y += step;
          if (y >= document.body.scrollHeight) { clearInterval(t); window.scrollTo(0, 0); res(); }
        }, 80);
      });
    }).catch(() => {});
    await page.addStyleTag({ content: `*,*::before,*::after{opacity:1!important;transform:none!important;animation:none!important;transition:none!important;visibility:visible!important;filter:none!important}` }).catch(() => {});
    await page.evaluate(() => window.dispatchEvent(new Event('resize'))).catch(() => {});  // nudge responsive charts
    await page.evaluate(async () => { if (document.fonts) await document.fonts.ready; }).catch(() => {});
    await page.waitForTimeout(1_500);
    const textLen = await page.evaluate(() => document.body?.innerText?.trim().length ?? 0).catch(() => 0);
    const jpg = await page.screenshot({ type: 'jpeg', quality: 82, fullPage: true });
    return { jpg, b64: jpg.toString('base64'), textLen };
  } finally {
    await page.close().catch(() => {});
    if (!browser) await b.close().catch(() => {});
  }
}

// ---- coder ------------------------------------------------------------------
const CODER_SYS = `You generate a SINGLE self-contained HTML file (inline <style>/<script>, CDN deps allowed).
- Use TailwindCSS (play CDN) + font-awesome. Style everything — never ship raw HTML.
- Prefer proven "expert template" structures; nail the above-the-fold hero.
- If you use chart.js / three.js, wire them so they ACTUALLY render (init after DOM, real data, a real new Chart()/scene).
- Use real external CDN images (images.unsplash.com), not empty boxes.
- Keep internal planning brief — spend the budget on the complete HTML.
Return ONLY the HTML, starting with <!doctype html>.`;
// Aesthetic/taste rules (no purple gradients, etc.) come from the standing-intent profile, injected below.

const PATCH_SYS = `You are FIXING an existing HTML page. You get the current full HTML plus a numbered list of fixes from a visual QA review.
- Apply EVERY fix. Change ONLY what they require; preserve all other markup, copy, styling, scripts EXACTLY — do not drop working sections.
- If a fix says a chart/widget didn't render, ADD the real init JS (e.g. an actual new Chart(...) wired to the canvas).
- Keep Tailwind + real CDN images; no purple gradients.
Return the COMPLETE corrected HTML, starting with <!doctype html>. Output ONLY the HTML.`;

// Standing-intent profile — taste lives in ~/.taste/profile.md, shared with every other harness.
const TASTE = loadTaste(['design', 'code', 'frontend', 'writing']);
const tasteBlock = TASTE ? `\n\nStanding preferences (honor unless the prompt overrides):\n${TASTE}` : '';

export const stripToHtml = (s: string) => {
  const m = s.match(/<!doctype html[\s\S]*<\/html>/i) || s.match(/```html?\n([\s\S]*?)```/i);
  return m ? (m[1] ?? m[0]) : s;
};

// ---- critic -----------------------------------------------------------------
const QA_SYS = `You are a strict visual QA reviewer for generated web pages. You are shown a full-page screenshot.
Judge ONLY what you can see. Check: renders, styled, layout, images-loaded, widgets-rendered (charts/3D actually drew), taste (no purple-gradient/generic-AI look), fidelity (matches the request).
Return ONLY JSON (no prose, no code fences):
{"pass": true|false,
 "scores": {"renders":0-5,"styled":0-5,"layout":0-5,"images":0-5,"widgets":0-5,"taste":0-5,"fidelity":0-5},
 "defects": [{"severity":"blocker|major|minor","category":"...","what":"what is visually wrong",
              "fix_instruction":"the concrete code-level change to make — which element/section to add or edit and how. Do NOT merely restate the problem."}]}
Set pass=false if ANY blocker exists or any score <= 2.`;

export const extractJson = (s: string) => { const m = s.match(/\{[\s\S]*\}/); return m ? m[0] : s; };

export function parseReport(raw: string): QAReport {
  const r = JSON.parse(extractJson(raw));
  r.scores ??= {}; r.defects ??= []; r.pass = !!r.pass;
  return r as QAReport;
}

async function critique(cfg: ModelCfg, b64: string, prompt: string) {
  const out = await chat(cfg, [
    { role: 'system', content: QA_SYS },
    { role: 'user', content: [
      { type: 'text', text: `User asked for: ${prompt}` },
      { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } },
    ] },
  ], 0);
  return { report: parseReport(out.content), inTok: out.inTok, outTok: out.outTok };
}

// confident fail = a cheap critic finding a blocker / score<=2; trust it without escalating
export const confidentFail = (r: QAReport) => !r.pass && (r.defects.some((d) => d.severity === 'blocker') || Object.values(r.scores).some((s) => s <= 2));

// ---- the loop ---------------------------------------------------------------
export async function runLoop(prompt: string, cfg: RunConfig): Promise<RunResult> {
  const log = cfg.log ?? (() => {});
  const usage: Usage = { coderIn: 0, coderOut: 0, criticIn: 0, criticOut: 0 };
  const perRound: RoundInfo[] = [];
  const shots: { round: number; jpg: Buffer }[] = [];
  const t0 = now();
  const browser = await chromium.launch();
  let prevHtml: string | undefined, fixes: string | undefined;
  let last: { html: string; report: QAReport } | undefined;

  try {
    for (let round = 1; round <= cfg.maxRounds; round++) {
      const mode: 'scratch' | 'patch' = prevHtml && fixes ? 'patch' : 'scratch';
      const g0 = now();
      log(`round ${round}: ${mode} generate (${cfg.coder.model})`);
      const gen = mode === 'patch'
        ? await chat(cfg.coder, [
            { role: 'system', content: PATCH_SYS + tasteBlock },
            { role: 'user', content: `Original request (context): ${prompt}\n\nFixes to apply:\n${fixes}\n\nCURRENT HTML — return the full corrected version:\n\n${prevHtml}` },
          ], 0.4)
        : await chat(cfg.coder, [
            { role: 'system', content: CODER_SYS + tasteBlock },
            { role: 'user', content: prompt },
          ], 0.7);
      usage.coderIn += gen.inTok; usage.coderOut += gen.outTok;
      const html = stripToHtml(gen.content);
      const genMs = now() - g0;

      const shot = await renderAndShoot(html, cfg.viewport, browser);
      shots.push({ round, jpg: shot.jpg });

      if (shot.textLen < 30) {                              // blank-capture guard (real text, not bytes)
        log(`round ${round}: BLANK (text=${shot.textLen}) — regenerate from scratch next round`);
        prevHtml = undefined; fixes = undefined;
        last = { html, report: { pass: false, scores: { renders: 0 }, defects: [] } };
        perRound.push({ round, mode, genMs, qaMs: 0, chars: html.length, pass: false, scores: { renders: 0 }, defects: 0, criticModel: '—' });
        continue;
      }

      // critique (optional cheap-screen → escalate)
      const q0 = now();
      let report: QAReport, criticModel: string;
      if (cfg.cheapCritic) {
        log(`round ${round}: screen (${cfg.cheapCritic.model})`);
        const cheap = await critique(cfg.cheapCritic, shot.b64, prompt);
        usage.criticIn += cheap.inTok; usage.criticOut += cheap.outTok;
        if (confidentFail(cheap.report)) {
          report = cheap.report; criticModel = cfg.cheapCritic.model;
        } else {
          log(`round ${round}: escalate (${cfg.critic.model})`);
          const strong = await critique(cfg.critic, shot.b64, prompt);
          usage.criticIn += strong.inTok; usage.criticOut += strong.outTok;
          report = strong.report; criticModel = cfg.critic.model;
        }
      } else {
        const strong = await critique(cfg.critic, shot.b64, prompt);
        usage.criticIn += strong.inTok; usage.criticOut += strong.outTok;
        report = strong.report; criticModel = cfg.critic.model;
      }
      const qaMs = now() - q0;
      last = { html, report };
      perRound.push({ round, mode, genMs, qaMs, chars: html.length, pass: report.pass, scores: report.scores, defects: report.defects.length, criticModel });
      log(`round ${round}: pass=${report.pass} scores=${JSON.stringify(report.scores)} defects=${report.defects.length}`);

      if (report.pass) break;
      prevHtml = html;
      fixes = report.defects.map((d, i) => `${i + 1}. [${d.severity}] ${d.fix_instruction || d.what}`).join('\n');
    }
  } finally {
    await browser.close().catch(() => {});
  }

  return {
    prompt, passed: !!last?.report.pass, rounds: perRound.length, html: last!.html, report: last!.report,
    totalMs: now() - t0, perRound, usage, shots,
  };
}
