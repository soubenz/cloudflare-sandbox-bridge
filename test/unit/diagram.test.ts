import { describe, it, expect } from 'vitest';
import { DIAGRAMS, KNOWN_DIAGRAMS, DiagramSchema, checkDiagram, diagramRefs, parseDiagramLibrary } from '../../src/labs/diagram';
import { LearnBundleSchema, checkLearnBundle } from '../../src/labs/learn';

const base = DiagramSchema.parse(DIAGRAMS.find((d) => d.id === 'gateway-alias-routing'));

describe('diagram library', () => {
  it('ships valid diagrams with unique ids', () => {
    expect(DIAGRAMS.length).toBeGreaterThan(0);
    expect(KNOWN_DIAGRAMS.size).toBe(DIAGRAMS.length);
    for (const d of DIAGRAMS) expect(checkDiagram(d), d.id).toEqual([]);
  });

  it('rejects markup in any text', () => {
    expect(() => DiagramSchema.parse({ ...base, title: '<b>x</b>' })).toThrow();
  });

  it('flags dangling references, unlit steps, crowding and unused nodes', () => {
    const bad = DiagramSchema.parse({
      ...base,
      edges: [...base.edges, { id: 'ghost', from: 'app', to: 'nope' }],
      nodes: [...base.nodes, { id: 'lonely', label: 'Lonely', kind: 'store', x: 12, y: 52 }],
      steps: [...base.steps, { caption: 'empty step' }, { caption: 'bad packet', packets: [{ edge: 'zzz' }] }],
    });
    const p = checkDiagram(bad).join('\n');
    expect(p).toMatch(/unknown node "nope"/);
    expect(p).toMatch(/too close together/);
    expect(p).toMatch(/lights nothing/);
    expect(p).toMatch(/unknown edge "zzz"/);
    expect(p).toMatch(/lonely is never used/);
  });

  it('parseDiagramLibrary reports duplicate ids', () => {
    expect(() => parseDiagramLibrary({ version: 1, diagrams: [base, base] })).toThrow(/share an id/);
  });
});

describe('embedding a diagram in a lesson', () => {
  it('finds ::diagram[id] only alone on a line', () => {
    expect(diagramRefs('a\n::diagram[one]\nb\n::diagram[two]  \ninline ::diagram[no] x')).toEqual(['one', 'two']);
  });

  it('checkLearnBundle flags an unknown diagram id', () => {
    const b = LearnBundleSchema.parse({
      version: 1,
      concepts: [{ id: 'gateway.routing-aliases', title: 'A', minutes: 1, recap: 'r', body: 'text\n\n::diagram[missing]' }],
      questions: [
        { id: 'q', concept: 'gateway.routing-aliases', type: 'single', prompt: 'p', options: [{ id: 'a', text: 'x' }, { id: 'b', text: 'y' }], answer: ['a'], explanation: 'e' },
      ],
    });
    expect(checkLearnBundle(b).join()).toMatch(/embeds diagram "missing"/);
    expect(checkLearnBundle(b, undefined, new Set(['missing']))).toEqual([]);
  });
});
