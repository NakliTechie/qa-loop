// src/cli.ts — command-line front end. Single prompt or a whole suite (batch).
//   node --import tsx/esm --env-file=.env src/cli.ts "a coffee subscription landing page"
//   node --import tsx/esm --env-file=.env src/cli.ts --suite suite.json --concurrency 3
// Flags: --coder --critic --cheap-critic --rounds --coder-maxtok --qa-maxtok --concurrency --out
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runLoop, type RunConfig, type ModelCfg, type RunResult } from './loop.ts';
import { costUsd, fmtUsd } from './prices.ts';

// ---- args -------------------------------------------------------------------
const argv = process.argv.slice(2);
const flags: Record<string, string> = {};
const positional: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) { const k = a.slice(2); const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true'; flags[k] = v; }
  else positional.push(a);
}

const env = process.env;
const baseCoder = env.CODER_URL ?? 'https://openrouter.ai/api/v1';
const baseQA = env.QA_URL ?? baseCoder;
const key = env.OPENAI_API_KEY ?? env.CODER_KEY ?? '';
if (!key) { console.error('Set OPENAI_API_KEY (and CODER_URL/QA_URL) — e.g. via --env-file=.env'); process.exit(1); }

const coder: ModelCfg = { baseUrl: baseCoder, model: flags.coder ?? env.CODER_MODEL ?? 'z-ai/glm-5.2', key, maxTok: Number(flags['coder-maxtok'] ?? env.CODER_MAXTOK ?? 16_000) };
const critic: ModelCfg = { baseUrl: baseQA, model: flags.critic ?? env.QA_MODEL ?? 'z-ai/glm-4.6v', key, maxTok: Number(flags['qa-maxtok'] ?? env.QA_MAXTOK ?? 2_000) };
const cheapCritic: ModelCfg | null = flags['cheap-critic']
  ? { baseUrl: baseQA, model: flags['cheap-critic'], key, maxTok: Number(flags['qa-maxtok'] ?? 2_000) } : null;
const cfg: RunConfig = {
  coder, critic, cheapCritic, maxRounds: Number(flags.rounds ?? env.MAXROUNDS ?? 4),
  log: (m) => console.log(`    ${m}`),
};
const outRoot = flags.out ?? 'runs';
const concurrency = Number(flags.concurrency ?? 3);

// ---- helpers ----------------------------------------------------------------
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'run';
const runCost = (r: RunResult) =>
  costUsd(coder.model, r.usage.coderIn, r.usage.coderOut) + costUsd(critic.model, r.usage.criticIn, r.usage.criticOut);

function writeRun(dir: string, name: string, r: RunResult) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'page.html'), r.html);
  const shotFiles = r.shots.map((s) => { const f = `round-${s.round}.jpg`; writeFileSync(join(dir, f), s.jpg); return f; });
  const meta = {
    name, prompt: r.prompt, passed: r.passed, rounds: r.rounds,
    totalSec: +(r.totalMs / 1000).toFixed(1), costUsd: +runCost(r).toFixed(4),
    finalScores: r.report.scores, openDefects: r.report.defects, usage: r.usage,
    perRound: r.perRound, shots: shotFiles,
  };
  writeFileSync(join(dir, 'result.json'), JSON.stringify(meta, null, 2));
  return meta;
}

const verdict = (r: RunResult) => (r.passed ? '✓ pass' : '✗ fail');

// ---- run --------------------------------------------------------------------
async function pool<T, R>(items: T[], n: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const res: R[] = new Array(items.length);
  let idx = 0;
  const worker = async () => { while (idx < items.length) { const i = idx++; res[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return res;
}

async function main() {
  console.log(`coder=${coder.model} (maxtok ${coder.maxTok})  critic=${critic.model}${cheapCritic ? `  cheap-critic=${cheapCritic.model}` : ''}  rounds≤${cfg.maxRounds}`);

  if (flags.suite) {
    const suite: { name: string; prompt: string }[] = JSON.parse(readFileSync(flags.suite, 'utf8'));
    console.log(`suite: ${suite.length} prompts, concurrency ${concurrency} → ${outRoot}/\n`);
    const results = await pool(suite, concurrency, async (item, i) => {
      console.log(`[${i + 1}/${suite.length}] ${item.name} …`);
      try {
        const r = await runLoop(item.prompt, { ...cfg, log: (m) => console.log(`    [${item.name}] ${m}`) });
        const meta = writeRun(join(outRoot, slug(item.name)), item.name, r);
        console.log(`[${i + 1}/${suite.length}] ${item.name}: ${verdict(r)} in ${meta.rounds} round(s), ${meta.totalSec}s, ${fmtUsd(meta.costUsd)}`);
        return meta;
      } catch (e: any) {
        console.log(`[${i + 1}/${suite.length}] ${item.name}: ERROR ${String(e.message).slice(0, 120)}`);
        return { name: item.name, prompt: item.prompt, passed: false, rounds: 0, totalSec: 0, costUsd: 0, finalScores: {}, error: String(e.message).slice(0, 200) };
      }
    });

    // aggregate
    const pass = results.filter((r: any) => r.passed).length;
    const cost = results.reduce((s: number, r: any) => s + (r.costUsd || 0), 0);
    const secs = results.reduce((s: number, r: any) => s + (r.totalSec || 0), 0);
    writeFileSync(join(outRoot, 'summary.json'), JSON.stringify({ pass, total: results.length, costUsd: +cost.toFixed(4), results }, null, 2));
    const axes = ['renders', 'styled', 'layout', 'images', 'widgets', 'taste', 'fidelity'];
    const md = [
      `# qa-loop stress run`,
      ``,
      `**${pass}/${results.length} passed** · total ${fmtUsd(cost)} · ${(secs / 60).toFixed(1)} min of model time · coder \`${coder.model}\` · critic \`${critic.model}\``,
      ``,
      `| Prompt | Verdict | Rounds | Time | Cost | ${axes.join(' | ')} |`,
      `|---|---|--:|--:|--:|${axes.map(() => '--:').join('|')}|`,
      ...results.map((r: any) => `| ${r.name} | ${r.error ? '⚠️ err' : r.passed ? '✓' : '✗'} | ${r.rounds} | ${r.totalSec}s | ${fmtUsd(r.costUsd || 0)} | ${axes.map((a) => r.finalScores?.[a] ?? '–').join(' | ')} |`),
    ].join('\n');
    writeFileSync(join(outRoot, 'summary.md'), md + '\n');
    console.log(`\n=== ${pass}/${results.length} passed · ${fmtUsd(cost)} · ${outRoot}/summary.md ===`);
  } else {
    const prompt = positional[0] ?? 'a landing page for a specialty coffee subscription';
    const r = await runLoop(prompt, cfg);
    const meta = writeRun(join(outRoot, slug(prompt)), prompt, r);
    console.log(`\n=== ${verdict(r)} in ${meta.rounds} round(s) · ${meta.totalSec}s · ${fmtUsd(meta.costUsd)} · ${join(outRoot, slug(prompt))}/ ===`);
  }
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
