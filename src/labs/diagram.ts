import { z } from 'zod';
import library from '../../packages/catalogue/diagrams.json';

/**
 * Animated explainer diagrams. A diagram is data, never markup: nodes on a
 * 0-100 grid, edges between them, and an ordered list of steps. Each step
 * lights some nodes, sends labelled packets along some edges and carries one
 * caption. The console draws it as SVG, plays the steps in turn and lets the
 * learner pause, step back and forth or read the captions as plain text.
 *
 * Diagrams live in packages/catalogue/diagrams.json and are shared by every
 * lab and by the site. A lesson embeds one with `::diagram[<id>]` alone on a
 * line (docs/learning-content.md).
 */

const id = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/, 'lowercase letters, digits and hyphens');
const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((s) => !/[<>]/.test(s) && !s.includes('\n'), 'plain single-line text, no markup');

export const NODE_KINDS = ['client', 'gateway', 'service', 'store', 'model', 'tool', 'person', 'log'] as const;
export const TONES = ['default', 'ok', 'warn', 'bad'] as const;

const NodeSchema = z.object({
  id,
  label: text(24),
  sub: text(28).optional(),
  kind: z.enum(NODE_KINDS),
  x: z.number().min(4).max(96),
  y: z.number().min(6).max(94),
});

const EdgeSchema = z.object({
  id,
  from: id,
  to: id,
  label: text(20).optional(),
});

const PacketSchema = z.object({
  edge: id,
  /** Sends the packet from `to` back to `from` (a response). */
  reverse: z.boolean().default(false),
  label: text(20).optional(),
  tone: z.enum(TONES).default('default'),
});

const StepSchema = z.object({
  caption: text(180),
  /** Nodes drawn lit in this step. */
  active: z.array(id).max(8).default([]),
  packets: z.array(PacketSchema).max(4).default([]),
  /** Optional short text shown beside a node, e.g. a value the step reveals. */
  notes: z.array(z.object({ node: id, text: text(40), tone: z.enum(TONES).default('default') })).max(4).default([]),
});

export const DiagramSchema = z.object({
  id,
  title: text(80),
  /** What the whole diagram shows, read by screen readers before the steps. */
  summary: text(280),
  nodes: z.array(NodeSchema).min(2).max(10),
  edges: z.array(EdgeSchema).min(1).max(14),
  steps: z.array(StepSchema).min(2).max(8),
});
export type Diagram = z.infer<typeof DiagramSchema>;

export const DiagramLibrarySchema = z.object({
  version: z.literal(1),
  diagrams: z.array(DiagramSchema).max(60),
});

/** Problems a schema-valid diagram still has: dangling references, overlaps, unlit steps. */
export function checkDiagram(d: Diagram): string[] {
  const p: string[] = [];
  const at = `diagram ${d.id}`;
  const nodeIds = new Set(d.nodes.map((n) => n.id));
  const edgeIds = new Set(d.edges.map((e) => e.id));
  if (nodeIds.size !== d.nodes.length) p.push(`${at}: two nodes share an id`);
  if (edgeIds.size !== d.edges.length) p.push(`${at}: two edges share an id`);
  for (const e of d.edges) {
    if (!nodeIds.has(e.from)) p.push(`${at}: edge ${e.id} starts at unknown node "${e.from}"`);
    if (!nodeIds.has(e.to)) p.push(`${at}: edge ${e.id} ends at unknown node "${e.to}"`);
    if (e.from === e.to) p.push(`${at}: edge ${e.id} loops back to the same node`);
  }
  for (let i = 0; i < d.nodes.length; i++) {
    for (let j = i + 1; j < d.nodes.length; j++) {
      const a = d.nodes[i]!;
      const b = d.nodes[j]!;
      if (Math.hypot(a.x - b.x, a.y - b.y) < 14) p.push(`${at}: nodes ${a.id} and ${b.id} sit too close together to read`);
    }
  }
  d.steps.forEach((s, i) => {
    const step = `${at} step ${i + 1}`;
    for (const n of s.active) if (!nodeIds.has(n)) p.push(`${step}: active node "${n}" does not exist`);
    for (const pk of s.packets) if (!edgeIds.has(pk.edge)) p.push(`${step}: packet on unknown edge "${pk.edge}"`);
    for (const n of s.notes) if (!nodeIds.has(n.node)) p.push(`${step}: note on unknown node "${n.node}"`);
    if (s.active.length === 0 && s.packets.length === 0) p.push(`${step}: lights nothing and sends nothing`);
  });
  const used = new Set<string>();
  for (const s of d.steps) {
    s.active.forEach((n) => used.add(n));
    s.packets.forEach((pk) => {
      const e = d.edges.find((x) => x.id === pk.edge);
      if (e) {
        used.add(e.from);
        used.add(e.to);
      }
    });
  }
  for (const n of d.nodes) if (!used.has(n.id)) p.push(`${at}: node ${n.id} is never used by any step`);
  return p;
}

export function parseDiagramLibrary(raw: unknown): Diagram[] {
  const parsed = DiagramLibrarySchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error('Invalid diagram library: ' + parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '));
  }
  const problems = parsed.data.diagrams.flatMap(checkDiagram);
  const ids = parsed.data.diagrams.map((d) => d.id);
  if (new Set(ids).size !== ids.length) problems.push('two diagrams share an id');
  if (problems.length > 0) throw new Error('Invalid diagram library: ' + problems.join('; '));
  return parsed.data.diagrams;
}

/** Every diagram in the shared library. */
export const DIAGRAMS: readonly Diagram[] = parseDiagramLibrary(library);
export const KNOWN_DIAGRAMS: ReadonlySet<string> = new Set(DIAGRAMS.map((d) => d.id));

/** Ids embedded in a lesson body with `::diagram[id]` alone on a line. */
export function diagramRefs(markdown: string): string[] {
  const out: string[] = [];
  for (const m of markdown.matchAll(/^::diagram\[([^\]\n]*)\][ \t]*$/gm)) out.push(m[1] ?? '');
  return out;
}
