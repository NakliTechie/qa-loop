import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderAndShoot } from '../src/loop.ts';

// First-run smoke for the render layer (no API). Guards the exact class of bug
// that derailed the project: a capture that misses scroll-animated content.
test('renderAndShoot produces a non-blank full-page capture', async () => {
  const html = `<!doctype html><html><head><style>
    .reveal{opacity:0;transition:opacity .3s} .reveal.shown{opacity:1}
    section{height:1200px;font-size:40px;padding:40px}</style></head><body>
    <section>HERO VISIBLE</section>
    <section class="reveal" id="r">REVEALED ON SCROLL</section>
    <script>
      const o = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) e.target.classList.add('shown'); }));
      o.observe(document.getElementById('r'));
    </script></body></html>`;
  const shot = await renderAndShoot(html, { width: 800, height: 600 });
  assert.ok(shot.textLen > 20, `expected visible text, got textLen=${shot.textLen}`);
  assert.ok(shot.jpg.length > 5000, `expected a real screenshot, got ${shot.jpg.length} bytes`);
}, { timeout: 60_000 });
