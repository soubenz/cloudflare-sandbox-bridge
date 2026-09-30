import { describe, it, expect, vi } from 'vitest';
import { degradedTransition, postAlert, alertPayload, degradedMessage, recoveredMessage } from '../../src/lib/pool-health';

const base = { degraded: false, target: 1, warm: 0, failures: 0 };

describe('degradedTransition', () => {
  it.each([
    ['no alert at 0 failures', { ...base, failures: 0 }, null],
    ['no alert at 1 failure', { ...base, failures: 1 }, null],
    ['no alert at 2 failures', { ...base, failures: 2 }, null],
    ['degrade at 3 failures, target>0, warm 0', { ...base, failures: 3 }, 'degrade'],
    ['degrade at 7 failures too', { ...base, failures: 7 }, 'degrade'],
    ['no degrade when target is 0', { ...base, target: 0, failures: 5 }, null],
    ['no degrade while warm containers exist', { ...base, warm: 1, failures: 5 }, null],
    ['no repeat while already degraded and still failing', { ...base, degraded: true, failures: 4 }, null],
    ['recover on a successful start after degraded', { degraded: true, target: 1, warm: 1, failures: 0 }, 'recover'],
    ['no recovery event when healthy', { degraded: false, target: 1, warm: 1, failures: 0 }, null],
  ] as const)('%s', (_name, prev, expected) => {
    expect(degradedTransition(prev)).toBe(expected);
  });
});

describe('postAlert', () => {
  it('POSTs JSON with both text (Slack) and content (Discord)', async () => {
    const fake = vi.fn(async () => new Response('ok'));
    const text = degradedMessage('agent', 'ApiError:500: image not found');
    await postAlert('https://hooks.example/x', text, fake as unknown as typeof fetch);
    expect(fake).toHaveBeenCalledTimes(1);
    const [url, init] = fake.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://hooks.example/x');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'content-type': 'application/json' });
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ text: 'opalix: agent pool degraded — ApiError:500: image not found', content: 'opalix: agent pool degraded — ApiError:500: image not found' });
    expect(body).toEqual(alertPayload(text));
  });

  it('does nothing without a webhook URL', async () => {
    const fake = vi.fn();
    await postAlert(undefined, 'x', fake as unknown as typeof fetch);
    expect(fake).not.toHaveBeenCalled();
  });

  it('swallows fetch errors', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fake = vi.fn(async () => {
      throw new Error('network down');
    });
    await expect(postAlert('https://hooks.example/x', 'x', fake as unknown as typeof fetch)).resolves.toBeUndefined();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('has a recovery message', () => {
    expect(recoveredMessage('gateway')).toBe('opalix: gateway pool recovered');
  });
});
