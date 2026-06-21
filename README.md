# qa-loop — text-only coder + multimodal QA

A **generate → render → screenshot → critique → repair** loop that pairs a **text-only coding model**
(GLM-5.2) with an **open vision critic** (GLM-4.6V). The coder writes the HTML; the critic looks at a
screenshot of the rendered page and grades it; failed checks are fed back as concrete fixes. Repeat
until it passes.

### 📄 Read the report → **https://naklitechie.github.io/qa-loop/**

The report links to the actual generated page (served live), a before/after of the key bug, and all
five run logs.

## The headline finding

The loop's hardest "failure to converge" was **not the model** — it was the **harness**. GLM-5.2 builds
scroll-reveal pages (`opacity:0` + `IntersectionObserver`); a full-page screenshot that *doesn't scroll*
captures those sections blank, so the critic honestly reports present sections as "missing." The critic
was right; the screenshot lied.

> A text-coder + vision-QA loop has **three** components that must be correct, not two: the coder, the
> critic, **and the render/capture between them.** Before blaming the model, verify the harness is
> actually showing the critic what got built.

Fix the capture (reveal scroll content before shooting) and stream the long generation (GLM-5.2 runs
~300s, past a gateway's idle timeout), and the all-open all-GLM loop converges **5/5 in a single round**
at 46,098 chars.

## Run it

```bash
npm run setup                                  # install deps + Chromium

# put CODER_MODEL / QA_MODEL / CODER_URL / QA_URL / OPENAI_API_KEY in a .env, then:
npm run qa -- "a landing page for a coffee subscription"   # one prompt
npm run stress                                 # a whole suite (suite.json) → runs/summary.md
npm test                                       # no-API smoke tests
```

Provider-agnostic (OpenAI-compatible): point `CODER_URL` / `QA_URL` at OpenRouter, TokenRouter, or a
self-hosted vLLM/SGLang endpoint to run entirely on your own GPUs. Flags: `--coder`, `--critic`,
`--cheap-critic <model>` (screen cheap, escalate only on borderline verdicts), `--rounds`,
`--concurrency`, `--out`.

**Layout** — [`src/loop.ts`](src/loop.ts) is the engine (render + coder + critic + the loop, with
cost/latency/token metrics); [`src/cli.ts`](src/cli.ts) is the CLI / batch runner; [`suite.json`](suite.json)
is the stress suite; each run writes `runs/<slug>/` (page.html, per-round screenshots, `result.json`).

| Role | Model | Notes |
|------|-------|-------|
| Coder | `z-ai/glm-5.2` | text-only, MIT-licensed |
| Critic | `z-ai/glm-4.6v` | open vision model |
| Render | Playwright + Chromium | reveals scroll-animated content before capture |

Built on the [Design Arena GLM-5.2 teardown](https://x.com/i/article/2067849694232080384). The "Tidepool"
brand and copy in the sample output are model-generated placeholders.
