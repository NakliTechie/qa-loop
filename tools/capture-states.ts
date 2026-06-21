// tools/capture-states.ts
// Renders the final generated page two ways to show why the harness mattered:
//   before-fix.jpg — naive fullPage screenshot (no scroll): scroll-reveal sections stay invisible
//   after-fix.jpg  — scroll to trip observers + force-reveal + resize: the critic sees everything
// No API calls — pure Playwright over the committed HTML.
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const html = readFileSync('outputs/tidepool.html', 'utf8');

async function shoot(reveal: boolean, path: string) {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  await p.setContent(html, { waitUntil: 'networkidle', timeout: 60_000 }).catch(() => {});
  if (reveal) {
    await p.evaluate(async () => {
      await new Promise<void>((res) => {
        let y = 0; const step = Math.max(200, window.innerHeight * 0.8);
        const t = setInterval(() => {
          window.scrollTo(0, y); y += step;
          if (y >= document.body.scrollHeight) { clearInterval(t); window.scrollTo(0, 0); res(); }
        }, 80);
      });
    }).catch(() => {});
    await p.addStyleTag({ content: `*,*::before,*::after{opacity:1!important;transform:none!important;animation:none!important;transition:none!important;visibility:visible!important;filter:none!important}` }).catch(() => {});
    await p.evaluate(() => window.dispatchEvent(new Event('resize'))).catch(() => {});
  }
  await p.evaluate(async () => { if (document.fonts) await document.fonts.ready; }).catch(() => {});
  await p.waitForTimeout(1_500);
  await p.screenshot({ path, type: 'jpeg', quality: 80, fullPage: true });
  await b.close();
  console.log('wrote', path);
}

await shoot(false, 'assets/before-fix.jpg');
await shoot(true, 'assets/after-fix.jpg');
