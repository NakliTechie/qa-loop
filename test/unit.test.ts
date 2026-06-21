import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripToHtml, extractJson, parseReport, confidentFail } from '../src/loop.ts';
import { costUsd } from '../src/prices.ts';

test('stripToHtml pulls the document out of chatter', () => {
  const s = 'Sure!\n<!doctype html><html><body>hi</body></html>\nHope that helps';
  const out = stripToHtml(s);
  assert.match(out, /^<!doctype html>/i);
  assert.ok(!/Hope that helps/.test(out));
});

test('stripToHtml handles ```html fences', () => {
  assert.match(stripToHtml('```html\n<!doctype html><html></html>\n```'), /<!doctype html>/i);
});

test('extractJson grabs the JSON object', () => {
  assert.equal(extractJson('noise {"a":1,"b":[2]} trailing'), '{"a":1,"b":[2]}');
});

test('parseReport is tolerant of preamble and missing fields', () => {
  const r = parseReport('verdict: {"pass":true,"scores":{"renders":5}}');
  assert.equal(r.pass, true);
  assert.equal(r.scores.renders, 5);
  assert.deepEqual(r.defects, []);
});

test('confidentFail trusts a cheap critic only on a real failure', () => {
  const block = { pass: false, scores: { layout: 4 }, defects: [{ severity: 'blocker', category: 'x', what: 'y', fix_instruction: 'z' }] };
  const minor = { pass: false, scores: { layout: 4 }, defects: [{ severity: 'minor', category: 'x', what: 'y', fix_instruction: 'z' }] };
  const passing = { pass: true, scores: { layout: 5 }, defects: [] };
  assert.equal(confidentFail(block), true);
  assert.equal(confidentFail(minor), false);   // borderline → escalate, don't trust the cheap one
  assert.equal(confidentFail(passing), false);
});

test('costUsd uses per-1M pricing', () => {
  assert.equal(+costUsd('z-ai/glm-5.2', 1e6, 1e6).toFixed(2), +(1.20 + 4.10).toFixed(2));
  assert.equal(costUsd('unknown/model', 1e6, 1e6), 0);
});
