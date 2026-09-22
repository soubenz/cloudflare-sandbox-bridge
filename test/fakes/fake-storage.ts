/**
 * Minimal in-memory stand-in for DurableObjectStorage, covering only what
 * session/timers.ts and session/state.ts touch: get/put/delete and the
 * alarm get/set/delete trio. Cast to `DurableObjectStorage` at the call
 * site — it deliberately does not implement the full interface (list,
 * transaction, sql, etc.), since those aren't exercised by the pure-logic
 * modules under test here.
 */
export function createFakeStorage() {
  const data = new Map<string, unknown>();
  let alarm: number | null = null;

  return {
    async get<T>(key: string): Promise<T | undefined> {
      return data.get(key) as T | undefined;
    },
    async put<T>(key: string, value: T): Promise<void> {
      data.set(key, value);
    },
    async delete(key: string): Promise<boolean> {
      return data.delete(key);
    },
    async getAlarm(): Promise<number | null> {
      return alarm;
    },
    async setAlarm(time: number): Promise<void> {
      alarm = time;
    },
    async deleteAlarm(): Promise<void> {
      alarm = null;
    },
    // Test helpers, not part of the real interface.
    _dump(): Map<string, unknown> {
      return data;
    },
  };
}
