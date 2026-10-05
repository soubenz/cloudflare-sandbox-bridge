import { describe, it, expect } from 'vitest';
import { parsePathInputs } from '../../src/path/inputs';

const ok = { areas: { gateway: 'new', mcp: 'familiar', rag: 'strong' }, goal_text: 'Get ready for a platform role', goal_kind: 'role-ready', hours_per_week: 5 };

const reject = (body: unknown) => {
  try {
    parsePathInputs(body);
  } catch (err) {
    return err as { status: number; code: string; message: string };
  }
  throw new Error('expected parsePathInputs to reject');
};

describe('path inputs: validation', () => {
  it('accepts a full body unchanged', () => {
    expect(parsePathInputs(ok)).toEqual(ok);
  });

  it('defaults the goal kind to explore, and the goal text to none', () => {
    expect(parsePathInputs({ areas: {}, hours_per_week: 3 })).toEqual({ areas: {}, goal_text: null, goal_kind: 'explore', hours_per_week: 3 });
  });

  describe('hours_per_week is a whole number from 1 to 20', () => {
    it.each([1, 10, 20])('accepts %s', (h) => expect(parsePathInputs({ ...ok, hours_per_week: h }).hours_per_week).toBe(h));
    it.each([0, 21, -3, 2.5, '5', null, NaN])('rejects %s', (h) => {
      const err = reject({ ...ok, hours_per_week: h });
      expect(err).toMatchObject({ status: 400, code: 'invalid_path_inputs' });
      expect(err.message).toContain('hours_per_week');
    });
    it('is required', () => expect(reject({ areas: {} }).message).toContain('hours_per_week'));
  });

  describe('goal_text is at most 200 characters', () => {
    it('accepts exactly 200', () => expect(parsePathInputs({ ...ok, goal_text: 'a'.repeat(200) }).goal_text).toHaveLength(200));
    it('rejects 201', () => expect(reject({ ...ok, goal_text: 'a'.repeat(201) }).message).toContain('goal_text'));
    it('rejects a non-string', () => expect(reject({ ...ok, goal_text: 42 }).code).toBe('invalid_path_inputs'));
    it.each([[''], ['   \n\t '], [null]])('treats %j as no goal', (t) => expect(parsePathInputs({ ...ok, goal_text: t }).goal_text).toBeNull());
    it('collapses whitespace and control characters to single spaces', () => {
      expect(parsePathInputs({ ...ok, goal_text: '  run\n\nthe   gateway\u0007now ' }).goal_text).toBe('run the gateway now');
    });
  });

  describe('goal_kind', () => {
    it.each(['role-ready', 'specific-skill', 'explore'])('accepts %s', (k) => expect(parsePathInputs({ ...ok, goal_kind: k }).goal_kind).toBe(k));
    it('rejects anything else', () => expect(reject({ ...ok, goal_kind: 'career' }).message).toContain('goal_kind'));
  });

  describe('areas', () => {
    it.each(['new', 'familiar', 'strong'])('accepts level %s', (l) => expect(parsePathInputs({ ...ok, areas: { gateway: l } }).areas).toEqual({ gateway: l }));
    it("accepts the console's 'ok' and stores it as 'familiar'", () => {
      expect(parsePathInputs({ ...ok, areas: { gateway: 'ok' } }).areas).toEqual({ gateway: 'familiar' });
    });
    it('rejects an unknown level', () => expect(reject({ ...ok, areas: { gateway: 'expert' } }).message).toContain('areas.gateway'));
    it('rejects an area the quiz does not have', () => {
      const err = reject({ ...ok, areas: { 'made-up': 'new' } });
      expect(err.message).toContain('unknown area "made-up"');
    });
    it('rejects a skill the quiz does not ask about, and accepts every one it does', () => {
      for (const id of ['runtime', 'agents', 'security', 'evals']) expect(reject({ ...ok, areas: { [id]: 'strong' } }).message, id).toContain(`unknown area "${id}"`);
      const all = { gateway: 'new', mcp: 'new', rag: 'new', otel: 'new', platform: 'new', sovereignty: 'new' };
      expect(parsePathInputs({ ...ok, areas: all }).areas).toEqual(all);
    });
    it('is required, and must be an object', () => {
      expect(reject({ hours_per_week: 5 }).message).toContain('areas');
      expect(reject({ ...ok, areas: ['gateway'] }).code).toBe('invalid_path_inputs');
    });
  });

  it('rejects unknown fields, a non-object body and a missing body', () => {
    expect(reject({ ...ok, user_id: 'someone-else' }).code).toBe('invalid_path_inputs');
    expect(reject('text').code).toBe('invalid_path_inputs');
    expect(reject(undefined).code).toBe('invalid_path_inputs');
    expect(reject(null).code).toBe('invalid_path_inputs');
  });
});
