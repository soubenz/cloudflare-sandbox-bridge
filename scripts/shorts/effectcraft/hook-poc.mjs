#!/usr/bin/env node
/**
 * Proof of concept: the hook of "Why an MCP gateway?" (video 2) built in EffectCraft
 * entirely over its headless MCP server, then rendered with effectcraft-cli.
 * See docs/research/effectcraft.md.
 *
 *   node scripts/shorts/effectcraft/hook-poc.mjs --cli <path to effectcraft-cli> \
 *        --out <dir> [--format vertical|landscape|both] [--audio hook.wav] [--no-render]
 *
 * Writes <out>/hook-<format>.ecproj and <out>/hook-<format>.mp4. The cue times are the
 * word times of the hook in the current render's timeline (<id>.timeline.json), so the
 * picture lands on the same words as our own renderer's version.
 */
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const CLI = args.cli;
const OUT = resolve(args.out || '.');
const FORMATS = (args.format || 'both') === 'both' ? ['vertical', 'landscape'] : [args.format];
if (!CLI) throw new Error('--cli <path to effectcraft-cli> is required');
mkdirSync(OUT, { recursive: true });

// Word times (s) from mcp-why-a-gateway.timeline.json: "Ten AI agents", "twenty MCP
// servers", "two hundred", "secret", "One box", "thirty"; the next page starts at 11.7.
const CUE = { agents: 0.3, servers: 1.48, lines: 3.56, secret: 6.32, box: 8.36, thirty: 9.84, end: 11.3 };
// The shorts theme (scripts/shorts/page/canvas.js, canvas.css, navy).
const C = { page: '#0a0f2c', fill: '#0c1336', top: '#0d1336', bottom: '#070b22', ink: '#e8ebf7',
  agent: '#8ab4ff', quiet: '#9aa2c4', gateway: '#c4a3ff', yellow: '#ffd166', orange: '#ffa94d', dot: '#9aabff' };
const FONT = { font: 'Kalam', style: 'Bold' }; // the board's hand font (installed from page/fonts)

/** A minimal MCP client: JSON-RPC 2.0, one message per line over the server's stdio. */
function mcp() {
  const child = spawn(CLI, ['mcp', '--empty'], { stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map();
  let id = 0;
  createInterface({ input: child.stdout }).on('line', (line) => {
    const msg = JSON.parse(line);
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
    else p.resolve(msg.result);
  });
  const request = (method, params) => new Promise((res, rej) => {
    pending.set(++id, { resolve: res, reject: rej });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const tool = async (name, a) => {
    const r = await request('tools/call', { name, arguments: a });
    const text = r.content?.find((c) => c.type === 'text')?.text;
    if (r.isError) throw new Error(`${name} ${JSON.stringify(a).slice(0, 300)}: ${text}`);
    try { return JSON.parse(text); } catch { return text; }
  };
  return {
    init: () => request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'hook-poc', version: '0' } }),
    tool,
    /** Several engine commands in one call and one undo step; a failing step rolls back. */
    batch: (steps, label) => tool('batch', { steps: steps.map(([command, params]) => ({ command, params })), label }),
    close: () => child.stdin.end(),
  };
}

async function build(format) {
  const W = format === 'vertical' ? 1080 : 1920;
  const H = format === 'vertical' ? 1920 : 1080;
  // The board's 1000 x 700 grid, scaled to the frame as our renderer does: the vertical
  // picture sits in the top part of the frame, the landscape one is centred and large.
  const s = format === 'vertical' ? 1.0 : 1.4;
  const ox = (W - 1000 * s) / 2;
  const oy = format === 'vertical' ? 110 : (H - 700 * s) / 2;
  const P = ([x, y]) => [ox + x * s, oy + y * s];
  const r2 = (v) => Math.round(v * 100) / 100;

  const ec = mcp();
  await ec.init();
  const key = (layer, path, keys, extra = {}) => ec.tool('add_keyframe', { layer, path, keys, timeBase: 'comp', ...extra });
  const text = (name, str, [cx, cy], size, fill, w = 900, extra = {}) => ['layer.newText', {
    name, text: str, ...FONT, size: size * s, fill, justify: 'center',
    box: [r2(cx - (w * s) / 2), r2(cy - size * s * 0.72), r2(w * s), r2(size * s * 2.6)], ...extra }];

  await ec.batch([
    ['comp.new', { name: 'Hook', width: W, height: H, frameRate: 30, duration: CUE.end, background: C.page, shutterAngle: 180, motionBlurSamples: 16 }],
    ['comp.setSwitch', { switch: 'motionBlur', value: true }],
  ], 'comp');

  // Background: navy gradient, a soft top light and the faint dot grid.
  await ec.batch([
    ['layer.newSolid', { name: 'BG', color: C.page, width: W, height: H }],
    ['effect.apply', { effect: 'Gradient Ramp', layers: ['BG'] }],
    ['layer.newShape', { kind: 'ellipse', name: 'Top light', size: [W * 1.3, H * 0.75], fill: '#3040a0', fillOpacity: 32, position: [W / 2, 0] }],
    ['effect.apply', { effect: 'Gaussian Blur', layers: ['Top light'] }],
    ['layer.newShape', { kind: 'ellipse', name: 'Dot grid', size: [3.2, 3.2], fill: C.dot, fillOpacity: 13, position: [0, 0] }],
  ], 'background');
  for (const [p, v] of [['effects/#1/start', [W / 2, 0]], ['effects/#1/startColor', C.top], ['effects/#1/end', [W / 2, H]], ['effects/#1/endColor', C.bottom]]) {
    await ec.tool('set_property', { layer: 'BG', path: p, value: v });
  }
  await ec.tool('set_property', { layer: 'Top light', path: 'effects/#1/blurriness', value: 180 * s });
  const rx = await ec.tool('execute_command', { command: 'layer.addShapeItem', params: { layer: 'Dot grid', kind: 'repeater' } });
  const ry = await ec.tool('execute_command', { command: 'layer.addShapeItem', params: { layer: 'Dot grid', kind: 'repeater' } });
  const rxp = rx.path ?? rx.result?.path; const ryp = ry.path ?? ry.result?.path;
  await ec.tool('set_property', { layer: 'Dot grid', path: `${rxp}/copies`, value: Math.ceil(W / 36) + 1 });
  await ec.tool('set_property', { layer: 'Dot grid', path: `${rxp}/transform/position`, value: [36, 0] });
  await ec.tool('set_property', { layer: 'Dot grid', path: `${ryp}/copies`, value: Math.ceil(H / 36) + 1 });
  await ec.tool('set_property', { layer: 'Dot grid', path: `${ryp}/transform/position`, value: [0, 36] });
  await ec.tool('set_property', { layer: 'Dot grid', path: 'transform/position', value: [18, 18] });
  // Fade the grid out towards the edges, as the page's mask-image does.
  await ec.batch([['layer.addMask', { layer: 'Dot grid', shape: 'ellipse', rect: [W * 0.075 - 18, H * 0.0 - 18, W * 0.85, H * 0.78] }],
    ['layer.mask.set', { layer: 'Dot grid', field: 'feather', value: Math.min(W, H) * 0.3 }]]);

  // The question: kicker, hand-written title and its dashed underline.
  await ec.batch([
    text('Kicker', 'INTERVIEW QUESTION', P([500, 34]), 28, C.orange, 900, { tracking: 100 }),
    text('Title', '10 agents, 20 MCP servers. How do you manage access?', P([500, 112]), 48, C.ink, 920, { smallCaps: true, leading: 52 * s }),
    ['shape.newPath', { vertices: [P([90, 196]), P([910, 196])], space: 'comp', stroke: C.ink, strokeOpacity: 85, strokeWidth: 3 * s, fill: false, name: 'Underline' }],
  ], 'title');
  await ec.tool('set_property', { layer: 'Underline', path: 'contents/group/contents/stroke/dashes/dash', value: 11 * s });
  await ec.tool('set_property', { layer: 'Underline', path: 'contents/group/contents/stroke/dashes/gap', value: 11 * s });

  // Ten agents and twenty servers, one shape layer per dot so each can pop on its own.
  const agentY = (i) => 430 - 164 + 11 + i * 34; // 10 dots of 22 with gaps of 12, centred on 430
  const serverY = (j) => 430 - 163.25 + 6.5 + j * 16.5; // 20 dots of 13 with gaps of 3.5
  const dots = [];
  for (let i = 0; i < 10; i++) dots.push(['layer.newShape', { kind: 'ellipse', name: `A${i}`, size: [22 * s, 22 * s], fill: C.fill, stroke: C.agent, strokeWidth: 3 * s, position: P([120, agentY(i)]) }]);
  for (let j = 0; j < 20; j++) dots.push(['layer.newShape', { kind: 'ellipse', name: `S${j}`, size: [13 * s, 13 * s], fill: C.fill, stroke: C.quiet, strokeWidth: 2.4 * s, position: P([880, serverY(j)]) }]);
  await ec.batch(dots, 'dots');
  // "Ten AI agents": a wave of small bumps down the column. "twenty MCP servers": they pop in.
  for (let i = 0; i < 10; i++) {
    const t = CUE.agents + i * 0.05;
    await key(`A${i}`, 'transform/scale', [{ time: t, value: [100, 100] }, { time: t + 0.18, value: [140, 140] }, { time: t + 0.45, value: [100, 100] }], { interpolation: 'easyEase' });
  }
  for (let j = 0; j < 20; j++) {
    const t = CUE.servers + j * 0.03;
    await key(`S${j}`, 'transform/scale', [{ time: t, value: [0, 0] }, { time: t + 0.22, value: [125, 125] }, { time: t + 0.4, value: [100, 100] }], { interpolation: 'easyEase' });
  }

  // The 200 connections: one path per agent-server pair, every path an expression of time.
  // It draws itself on (ease out), and later its middle vertex slides to the gateway's centre
  // with an overshoot, so the 200 lines fold into 10 + 20 through the box.
  const box = P([500, 430]);
  await ec.tool('execute_command', { command: 'layer.newShape', params: { kind: 'none', name: 'Mesh', position: [0, 0] } });
  const paths = [];
  for (let i = 0; i < 10; i++) {
    for (let j = 0; j < 20; j++) {
      const a = P([120 + 13, agentY(i)]);
      const b = P([880 - 8, serverY(j)]);
      paths.push(['shape.newPath', { layer: 'Mesh', vertices: [a, a, a], space: 'comp', stroke: C.quiet, strokeWidth: 1.5 * s, fill: false }]);
    }
  }
  await ec.batch(paths, 'mesh paths');
  const exprs = [];
  for (let i = 0; i < 10; i++) {
    for (let j = 0; j < 20; j++) {
      const n = i * 20 + j;
      const a = P([120 + 13, agentY(i)]).map(r2);
      const b = P([880 - 8, serverY(j)]).map(r2);
      const t0 = r2(CUE.lines + i * 0.07 + j * 0.012);
      const t1 = r2(CUE.box + 0.5 + i * 0.03 + (19 - j) * 0.008);
      const expr = [
        `var a=[${a}], b=[${b}], c=[${box.map(r2)}];`,
        `var d=easeOut(time,${t0},${r2(t0 + 0.55)},0,1);`,
        'var e=b.map(function(v,k){return a[k]+(v-a[k])*d;});',
        'var m=[(a[0]+e[0])/2,(a[1]+e[1])/2];',
        `var u=Math.min(Math.max((time-${t1})/0.8,0),1); var k=1+2.2*Math.pow(u-1,3)+1.2*Math.pow(u-1,2);`, // ease out with a little overshoot
        'var v=[m[0]+(c[0]-m[0])*k, m[1]+(c[1]-m[1])*k];',
        'createPath([a,v,e],[],[],false)',
      ].join(' ');
      const path = n === 0 ? 'contents/group/contents/path/path' : `contents/group#${n + 1}/contents/path/path`;
      exprs.push(['prop.setExpression', { layer: 'Mesh', path, expression: expr }]);
    }
  }
  for (let k = 0; k < exprs.length; k += 50) await ec.batch(exprs.slice(k, k + 50), 'mesh expressions');
  // The whole mesh: grey at 40 %, then violet at 75 % with a glow as it routes through the box.
  await ec.batch([['effect.apply', { effect: 'Fill', layers: ['Mesh'] }], ['effect.apply', { effect: 'Glow', layers: ['Mesh'] }]], 'mesh look');
  await key('Mesh', 'effects/#1/color', [{ time: CUE.box + 0.5, value: C.quiet }, { time: CUE.box + 1.4, value: C.gateway }], { interpolation: 'easyEase' });
  await key('Mesh', 'transform/opacity', [{ time: CUE.box + 0.5, value: 40 }, { time: CUE.box + 1.4, value: 75 }], { interpolation: 'easyEase' });
  await ec.tool('set_property', { layer: 'Mesh', path: 'effects/#2/threshold', value: 55 });
  await ec.tool('set_property', { layer: 'Mesh', path: 'effects/#2/radius', value: 14 * s });
  await key('Mesh', 'effects/#2/intensity', [{ time: CUE.box + 0.5, value: 0 }, { time: CUE.box + 1.4, value: 0.5 }], { interpolation: 'easyEase' });

  // The count: written on with "two hundred", rolls from 200 to 30 as the lines fold.
  const roll = [CUE.box + 0.55, CUE.thirty + 0.2].map(r2);
  await ec.batch([text('Count', '10 × 20 = 200 connections', P([400, 648]), 36, C.orange, 560)], 'count');
  await ec.tool('set_property', { layer: 'Count', path: 'text/sourceText', expression:
    `var n=Math.round(ease(time,${roll[0]},${roll[1]},200,30)); time<${roll[0]} ? '10 × 20 = 200 connections' : (time<${roll[1]} ? n+' connections' : '10 + 20 = 30 connections')` });
  await ec.batch([['effect.apply', { effect: 'Linear Wipe', layers: ['Count'] }], ['effect.apply', { effect: 'Fill', layers: ['Count'] }]], 'count fx');
  await ec.tool('set_property', { layer: 'Count', path: 'effects/#1/angle', value: 270 });
  await ec.tool('set_property', { layer: 'Count', path: 'effects/#1/feather', value: 30 * s });
  await key('Count', 'effects/#1/completion', [{ time: CUE.lines, value: 100 }, { time: CUE.lines + 0.9, value: 0 }]);
  await key('Count', 'effects/#2/color', [{ time: roll[0], value: C.orange }, { time: roll[1], value: C.gateway }], { interpolation: 'easyEase' });

  // "each with its own secret": a yellow chip pops in; it dims once the gateway holds them.
  const chip = P([800, 648]);
  await ec.batch([
    ['layer.newShape', { kind: 'rounded', name: 'Chip', size: [200 * s, 46 * s], fill: C.fill, stroke: C.yellow, strokeWidth: 2.4 * s, position: chip }],
    text('Secrets', '200 secrets', [chip[0] + 16 * s, chip[1] + 3 * s], 26, C.yellow, 170),
    ['layer.newShape', { kind: 'ellipse', name: 'Key', size: [12 * s, 12 * s], fillType: 'none', stroke: C.yellow, strokeWidth: 2.4 * s, position: [chip[0] - 80 * s, chip[1]] }],
    ['shape.newPath', { layer: 'Key', vertices: [[chip[0] - 74 * s, chip[1]], [chip[0] - 62 * s, chip[1]], [chip[0] - 62 * s, chip[1] + 6 * s]], space: 'comp', stroke: C.yellow, strokeWidth: 2.4 * s, fill: false }],
    ['layer.setParent', { layers: ['Secrets', 'Key'], parent: 'Chip' }],
  ], 'chip');
  await key('Chip', 'transform/scale', [{ time: CUE.secret - 0.1, value: [0, 0] }, { time: CUE.secret + 0.2, value: [112, 112] }, { time: CUE.secret + 0.45, value: [100, 100] }], { interpolation: 'easyEase' });
  for (const l of ['Chip', 'Secrets', 'Key']) await key(l, 'transform/opacity', [{ time: CUE.box + 0.5, value: 100 }, { time: CUE.box + 1.2, value: 35 }], { interpolation: 'easyEase' });

  // "One box in the middle": the gateway drops in with motion blur, squashes as it lands,
  // sends out a ring and keeps a soft glow.
  await ec.batch([
    ['layer.newShape', { kind: 'rounded', name: 'Gateway', size: [250 * s, 96 * s], fill: C.fill, stroke: C.gateway, strokeWidth: 3.5 * s, position: box }],
    text('Gateway label', 'MCP gateway', [box[0], box[1] + 4 * s], 34, C.gateway, 250),
    ['layer.setParent', { layers: ['Gateway label'], parent: 'Gateway' }],
    ['layer.newShape', { kind: 'rounded', name: 'Ring', size: [250 * s, 96 * s], fillType: 'none', stroke: C.gateway, strokeWidth: 3 * s, position: box }],
    ['effect.apply', { effect: 'Glow', layers: ['Gateway'] }],
    ['layer.setSwitch', { layers: ['Gateway', 'Gateway label'], switch: 'motionBlur', value: true }],
  ], 'gateway');
  const land = CUE.box + 0.42;
  // The fall accelerates (quadratic) and bounces twice as it settles: an expression of time.
  await ec.tool('set_property', { layer: 'Gateway', path: 'transform/position', expression:
    `var t=time-${r2(CUE.box)}, D=${r2(land - CUE.box)}, x=${r2(box[0])}, y0=${r2(-150 * s)}, y1=${r2(box[1])};` +
    ` t<=0 ? [x,y0] : (t<D ? [x, y0+(y1-y0)*(t/D)*(t/D)] : [x, y1-${r2(26 * s)}*Math.exp(-(t-D)*7)*Math.abs(Math.sin((t-D)*11))])` });
  await key('Gateway', 'transform/scale', [
    { time: CUE.box, value: [100, 0] }, { time: CUE.box + 0.2, value: [90, 112] }, { time: land, value: [100, 100] },
    { time: land + 0.08, value: [114, 84] }, { time: land + 0.24, value: [96, 104] }, { time: land + 0.4, value: [100, 100] },
  ], { interpolation: 'easyEase' });
  await key('Gateway', 'effects/#1/intensity', [{ time: land, value: 0 }, { time: land + 0.15, value: 1.3 }, { time: land + 1.0, value: 0.5 }], { interpolation: 'easyEase' });
  const ring = `var u=Math.min(Math.max((time-${r2(land)})/0.7,0),1), k=1-Math.pow(1-u,3);`;
  await ec.tool('set_property', { layer: 'Ring', path: 'transform/scale', expression: `${ring} [100+75*k, 100+110*k]` });
  await ec.tool('set_property', { layer: 'Ring', path: 'transform/opacity', expression: `${ring} time<${r2(land)} ? 0 : 80*(1-u)` });

  // The narration of the same moment, so the comparison plays on the same words.
  if (args.audio) {
    const imp = await ec.tool('execute_command', { command: 'file.import', params: { paths: [resolve(args.audio)] } });
    await ec.tool('execute_command', { command: 'layer.addItem', params: { item: (imp.result ?? imp).items[0], time: 0 } });
  }

  const ecproj = join(OUT, `hook-${format}.ecproj`);
  await ec.tool('save_project', { path: ecproj });
  for (const t of [0.5, 2.2, 4.4, 7.0, 8.6, 9.2, 10.5]) {
    await ec.tool('render_frame', { time: t, path: join(OUT, `hook-${format}-${t.toFixed(1)}.png`), max_side: 960, inline: false });
  }
  ec.close();
  return ecproj;
}

for (const format of FORMATS) {
  const t0 = Date.now();
  const ecproj = await build(format);
  const t1 = Date.now();
  if (process.argv.includes('--no-render')) { console.log(`${format}: built in ${((t1 - t0) / 1000).toFixed(1)} s -> ${ecproj}`); continue; }
  const mp4 = join(OUT, `hook-${format}.mp4`);
  execFileSync(CLI, ['render', ecproj, '--comp', 'Hook', '--out', mp4, '--format', 'h264', '--audio', args.audio ? 'on' : 'off'], { stdio: 'inherit' });
  console.log(`${format}: built over MCP in ${((t1 - t0) / 1000).toFixed(1)} s, rendered in ${((Date.now() - t1) / 1000).toFixed(1)} s -> ${mp4}`);
}
