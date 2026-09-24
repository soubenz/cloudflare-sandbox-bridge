# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: 08-rejoin.spec.ts >> session continuity >> rejoins the same session after a reload instead of refusing
- Location: test/e2e/08-rejoin.spec.ts:4:3

# Error details

```
Error: expect(received).toBe(expected) // Object.is equality

Expected: "01m3a3bdc779fpjnbaybmjrtda"
Received: "01m3a3j61bnnzsw8zhqprdbkc9"
```

# Page snapshot

```yaml
- generic [active] [ref=f6e1]:
  - banner [ref=f6e2]:
    - generic [ref=f6e3]:
      - text: ▣
      - strong [ref=f6e4]: Opalix
      - text: lab console
    - generic [ref=f6e5]:
      - generic [ref=f6e6]: running
      - generic [ref=f6e7]: hello
      - generic [ref=f6e8]: 01m3a3j61bnnzsw8zhqprdbkc9
      - generic "Time until the hard timeout" [ref=f6e9]: 59:59 left
    - generic [ref=f6e10]:
      - button "Run checks" [ref=f6e11] [cursor=pointer]
      - button "Snapshot" [ref=f6e12] [cursor=pointer]
      - button "End session" [ref=f6e13] [cursor=pointer]
      - button "Operator" [ref=f6e14] [cursor=pointer]
  - main [ref=f6e15]:
    - complementary [ref=f6e16]:
      - generic [ref=f6e17]:
        - heading "Checks" [level=2] [ref=f6e18]
        - paragraph [ref=f6e20]: Not run yet.
      - generic [ref=f6e21]:
        - heading "Hints" [level=2] [ref=f6e22]
        - paragraph [ref=f6e24]: Hints unlock on a timer.
      - generic [ref=f6e25]:
        - heading [level=2] [ref=f6e26]:
          - text: Workspace
          - button "↻" [ref=f6e27] [cursor=pointer]
        - list [ref=f6e28]
    - generic [ref=f6e29]:
      - navigation [ref=f6e30]:
        - button "Terminal" [ref=f6e31] [cursor=pointer]
        - button "Editor" [ref=f6e32] [cursor=pointer]
        - button "echo" [ref=f6e34] [cursor=pointer]
      - generic [ref=f6e39]:
        - generic:
          - textbox "Terminal input"
    - complementary [ref=f6e81]:
      - generic [ref=f6e82]:
        - heading "Events 4" [level=2] [ref=f6e83]:
          - text: Events
          - generic [ref=f6e84]: "4"
        - list [ref=f6e85]:
          - listitem [ref=f6e86]:
            - generic [ref=f6e87]: 16:21:49
            - generic [ref=f6e88]: terminal
            - generic [ref=f6e89]: Terminal disconnected.
          - listitem [ref=f6e90]:
            - generic [ref=f6e91]: 16:21:49
            - generic [ref=f6e92]: session.state
            - generic [ref=f6e93]: running
          - listitem [ref=f6e94]:
            - generic [ref=f6e95]: 16:21:49
            - generic [ref=f6e96]: service.health
            - generic [ref=f6e97]: "echo: healthy"
          - listitem [ref=f6e98]:
            - generic [ref=f6e99]: 16:21:47
            - generic [ref=f6e100]: session.state
            - generic [ref=f6e101]: starting
  - contentinfo [ref=f6e102]:
    - generic [ref=f6e103]: API https://opalix-sandbox.soubenz94.workers.dev
    - button "change" [ref=f6e104] [cursor=pointer]
```

# Test source

```ts
  1  | import { test, expect, openConsole, startOrRejoin } from './fixtures';
  2  | 
  3  | test.describe('session continuity', () => {
  4  |   test('rejoins the same session after a reload instead of refusing', async ({ page }) => {
  5  |     await openConsole(page);
  6  |     const first = await startOrRejoin(page);
  7  | 
  8  |     await openConsole(page);
  9  |     const second = await startOrRejoin(page);
  10 | 
  11 |     // One live session per address: starting again must land back on the
  12 |     // one already running, not 409 with no way forward.
> 13 |     expect(second).toBe(first);
     |                    ^ Error: expect(received).toBe(expected) // Object.is equality
  14 |   });
  15 | 
  16 |   test('restores the workspace panels on a rejoin', async ({ page }) => {
  17 |     await openConsole(page);
  18 |     await startOrRejoin(page);
  19 | 
  20 |     await expect(page.locator('#fileList li').first()).toBeVisible({ timeout: 30_000 });
  21 |     await expect(page.locator('#serviceTabs .tab').first()).toBeVisible({ timeout: 30_000 });
  22 |     await expect(page.locator('#expiryTimer')).toHaveText(/left$/, { timeout: 30_000 });
  23 |   });
  24 | });
  25 | 
```