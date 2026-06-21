// Per-1M-token list pricing (USD), from OpenRouter's catalog (June 2026).
// Estimates for reporting; your gateway's effective price may differ slightly.
export const PRICES: Record<string, { in: number; out: number }> = {
  'z-ai/glm-5.2': { in: 1.20, out: 4.10 },
  'z-ai/glm-5.1': { in: 1.20, out: 4.10 },
  'z-ai/glm-4.6v': { in: 0.30, out: 0.90 },
  'z-ai/glm-4.6': { in: 0.43, out: 1.74 },
  'z-ai/glm-4.5v': { in: 0.30, out: 0.90 },
  'qwen/qwen3-vl-235b-a22b-instruct': { in: 0.20, out: 0.88 },
  'qwen/qwen3-vl-30b-a3b-instruct': { in: 0.10, out: 0.40 },
};

export function costUsd(model: string, inTok: number, outTok: number): number {
  const p = PRICES[model];
  if (!p) return 0;
  return (inTok * p.in + outTok * p.out) / 1e6;
}

export const fmtUsd = (n: number) => '$' + n.toFixed(n < 0.1 ? 4 : n < 10 ? 3 : 2);
