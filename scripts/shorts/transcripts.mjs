#!/usr/bin/env node
// Writes one transcript file per video from a scripts document, for the owner to review
// (docs/shorts.md, "Approval"): only the spoken text, page by page, grouped by scene.
//
//   node scripts/shorts/transcripts.mjs docs/research/mcp-gateway-scripts.md docs/transcripts/mcp
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const [src, outDir] = process.argv.slice(2);
if (!src || !outDir) {
  console.error('usage: transcripts.mjs <scripts.md> <out-dir>');
  process.exit(2);
}

const lines = readFileSync(src, 'utf8').split('\n');
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const cells = (row) => row.split('|').slice(1, -1).map((c) => c.trim());
const plain = (s) => s.replace(/\*\*/g, '').replace(/`/g, '');

// A section is a "## Video N. Title" heading, or a "### Hook variants" heading inside one.
const sections = [];
let current = null;
for (const line of lines) {
  const video = line.match(/^## Video (\d+)\. (.+)$/);
  const variant = line.match(/^###? Hook variants(?: \((.+)\))?/);
  if (video) {
    current = { n: video[1], title: video[2].trim(), rows: [] };
    sections.push(current);
  } else if (variant && current) {
    current = { n: `${current.n}b`, title: `${current.title}: hook variant B`, rows: [] };
    sections.push(current);
  } else if (/^## /.test(line)) {
    current = null;
  } else if (current && /^\| *\d+ *\|/.test(line)) {
    current.rows.push(cells(line));
  }
}

mkdirSync(outDir, { recursive: true });
for (const s of sections) {
  if (!s.rows.length) continue;
  let scene = '';
  let words = 0;
  const out = [`# Video ${s.n}. ${s.title}`, ''];
  const body = [];
  for (const [num, page, , voice] of s.rows) {
    const text = plain(voice ?? '');
    words += text.split(/\s+/).filter(Boolean).length;
    const [head, name] = plain(page).split(' · ');
    const sceneName = name !== undefined ? head : '';
    if (sceneName && !/^S\d+$/.test(sceneName) && sceneName !== scene) {
      scene = sceneName;
      body.push('', `## ${scene.replace(/^S(\d+) /, 'Scene $1: ')}`, '');
    }
    body.push(`${num}. **${name ?? head}.** ${text}`);
  }
  const minutes = words / 170;
  out.push(`${words} spoken words, about ${Math.floor(minutes)}:${String(Math.round((minutes % 1) * 60)).padStart(2, '0')} at 170 words a minute (page pauses come on top).`);
  out.push(...body, '');
  const file = join(outDir, `video-${s.n}-${slug(s.title)}.md`);
  writeFileSync(file, out.join('\n'));
  console.log(file);
}
