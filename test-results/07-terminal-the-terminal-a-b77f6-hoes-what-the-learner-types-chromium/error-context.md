# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: 07-terminal.spec.ts >> the terminal >> attaches and echoes what the learner types
- Location: test/e2e/07-terminal.spec.ts:4:3

# Error details

```
Error: expect(received).toBe(expected) // Object.is equality

Expected: true
Received: false
```

# Page snapshot

```yaml
- generic [ref=f2e1]:
  - banner [ref=f2e2]:
    - generic [ref=f2e3]:
      - text: ▣
      - strong [ref=f2e4]: Opalix
      - text: lab console
    - generic [ref=f2e5]:
      - generic [ref=f2e6]: running
      - generic [ref=f2e7]: hello
      - generic [ref=f2e8]: 01m3a3cd23jwa0pfhrasaypsh5
      - generic "Time until the hard timeout" [ref=f2e9]: 57:51 left
    - generic [ref=f2e10]:
      - button "Run checks" [ref=f2e11] [cursor=pointer]
      - button "Snapshot" [ref=f2e12] [cursor=pointer]
      - button "End session" [ref=f2e13] [cursor=pointer]
      - button "Operator" [ref=f2e14] [cursor=pointer]
  - main [ref=f2e15]:
    - complementary [ref=f2e16]:
      - generic [ref=f2e17]:
        - heading "Checks" [level=2] [ref=f2e18]
        - paragraph [ref=f2e20]: Not run yet.
      - generic [ref=f2e21]:
        - heading "Hints" [level=2] [ref=f2e22]
        - generic [ref=f2e23]: Write the value of $GREETING to /workspace/greeting.txt
      - generic [ref=f2e25]:
        - heading [level=2] [ref=f2e26]:
          - text: Workspace
          - button "↻" [ref=f2e27] [cursor=pointer]
        - list [ref=f2e28]:
          - listitem [ref=f2e29] [cursor=pointer]:
            - generic [ref=f2e30]: brief.md
            - generic [ref=f2e31]: 180 B
          - listitem [ref=f2e32] [cursor=pointer]:
            - generic [ref=f2e33]: index.html
            - generic [ref=f2e34]: 945 B
          - listitem [ref=f2e35] [cursor=pointer]:
            - generic [ref=f2e36]: README.md
            - generic [ref=f2e37]: 65 B
    - generic [ref=f2e38]:
      - navigation [ref=f2e39]:
        - button "Terminal" [ref=f2e40] [cursor=pointer]
        - button "Editor" [ref=f2e41] [cursor=pointer]
        - button "echo" [ref=f2e43] [cursor=pointer]
      - generic [ref=f2e48]:
        - generic:
          - textbox "Terminal input" [active]
    - complementary [ref=f2e90]:
      - generic [ref=f2e91]:
        - heading "Events 6" [level=2] [ref=f2e92]:
          - text: Events
          - generic [ref=f2e93]: "6"
        - list [ref=f2e94]:
          - listitem [ref=f2e95]:
            - generic [ref=f2e96]: 16:20:41
            - generic [ref=f2e97]: hint
            - generic [ref=f2e98]: Write the value of $GREETING to /workspace/greeting.txt
          - listitem [ref=f2e99]:
            - generic [ref=f2e100]: 16:20:17
            - generic [ref=f2e101]: terminal
            - generic [ref=f2e102]: Terminal disconnected.
          - listitem [ref=f2e103]:
            - generic [ref=f2e104]: 16:20:17
            - generic [ref=f2e105]: pressure
            - generic [ref=f2e106]: A burst arrives — Something changed. Check the workspace.
          - listitem [ref=f2e107]:
            - generic [ref=f2e108]: 16:20:17
            - generic [ref=f2e109]: session.state
            - generic [ref=f2e110]: running
          - listitem [ref=f2e111]:
            - generic [ref=f2e112]: 16:20:17
            - generic [ref=f2e113]: service.health
            - generic [ref=f2e114]: "echo: healthy"
          - listitem [ref=f2e115]:
            - generic [ref=f2e116]: 16:20:17
            - generic [ref=f2e117]: session.state
            - generic [ref=f2e118]: starting
  - contentinfo [ref=f2e119]:
    - generic [ref=f2e120]: API https://opalix-sandbox.soubenz94.workers.dev
    - button "change" [ref=f2e121] [cursor=pointer]
```

# Test source

```ts
  1  | import { test, expect, collectConsoleErrors, upgradeHeaderStripped } from './fixtures';
  2  | 
  3  | test.describe('the terminal', () => {
  4  |   test('attaches and echoes what the learner types', async ({ session }) => {
  5  |     const errors = collectConsoleErrors(session);
  6  | 
  7  |     await session.locator('.tab[data-view="terminal"]').click();
  8  |     await expect(session.locator('.xterm-screen')).toBeVisible({ timeout: 30_000 });
  9  | 
  10 |     // Let the shell draw its prompt before typing, or the first keystrokes
  11 |     // land before the PTY is listening.
  12 |     await session.waitForTimeout(2500);
  13 |     await session.locator('.xterm-screen').click();
  14 |     await session.keyboard.type('echo playwright-terminal-ok');
  15 |     await session.keyboard.press('Enter');
  16 | 
  17 |     const echoed = await session
  18 |       .waitForFunction(
  19 |         () => document.querySelector('.xterm-screen')?.textContent?.includes('playwright-terminal-ok'),
  20 |         null,
  21 |         { timeout: 30_000 }
  22 |       )
  23 |       .then(() => true)
  24 |       .catch(() => false);
  25 | 
  26 |     // Only skip on the specific evidence of a stripped handshake: a
  27 |     // genuinely broken terminal must still fail.
  28 |     test.skip(
  29 |       !echoed && upgradeHeaderStripped(errors),
  30 |       'the network between here and the API strips the WebSocket Upgrade header'
  31 |     );
> 32 |     expect(echoed).toBe(true);
     |                    ^ Error: expect(received).toBe(expected) // Object.is equality
  33 |   });
  34 | 
  35 |   test('renders an xterm viewport sized to its pane', async ({ session }) => {
  36 |     await session.locator('.tab[data-view="terminal"]').click();
  37 |     const screen = session.locator('.xterm-screen');
  38 |     await expect(screen).toBeVisible({ timeout: 30_000 });
  39 | 
  40 |     const box = await screen.boundingBox();
  41 |     expect(box?.width ?? 0).toBeGreaterThan(200);
  42 |     expect(box?.height ?? 0).toBeGreaterThan(100);
  43 |   });
  44 | });
  45 | 
```