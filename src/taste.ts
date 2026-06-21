// taste.ts — load the standing-intent / taste profile that this (and every) harness reads.
// Vendored from NakliTechie/explorations/standing-intent (a ~35-line zero-dep loader).
// Resolution (later appends to earlier, so project refines global):
//   1. global   ~/.taste/profile.md   (override path with $TASTE_PROFILE)
//   2. project  ./taste.md            (in the harness's working dir)
// loadTaste() returns '' if no profile exists — harnesses degrade gracefully to their built-in prompt.
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const GLOBAL_PROFILE = process.env.TASTE_PROFILE ?? join(homedir(), '.taste', 'profile.md');
export const PROJECT_PROFILE = 'taste.md';

/** Resolved profile text. Pass section-name substrings (matched against `## ` headings) to filter. */
export function loadTaste(sections?: string[]): string {
  const parts: string[] = [];
  for (const p of [GLOBAL_PROFILE, PROJECT_PROFILE]) if (existsSync(p)) parts.push(readFileSync(p, 'utf8').trim());
  let text = parts.join('\n\n');
  if (sections?.length) text = filterSections(text, sections);
  return text.trim();
}

function filterSections(md: string, want: string[]): string {
  const lw = want.map((w) => w.toLowerCase());
  return md
    .split(/\n(?=## )/)
    .filter((block) => {
      const h = block.match(/^##\s*(.+)/);
      return h ? lw.some((w) => h[1].toLowerCase().includes(w)) : false;
    })
    .join('\n\n')
    .trim();
}
