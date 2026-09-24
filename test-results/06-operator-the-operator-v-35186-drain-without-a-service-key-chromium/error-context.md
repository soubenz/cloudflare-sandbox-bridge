# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: 06-operator.spec.ts >> the operator view >> refuses prime and drain without a service key
- Location: test/e2e/06-operator.spec.ts:27:3

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator:  locator('.tile').first()
Expected: visible
Received: hidden
Timeout:  30000ms

Call log:
  - Expect "toBeVisible" locator('.tile').first() with timeout 30000ms
  - waiting for locator('.tile').first()
    59 × locator resolved to <div class="tile">…</div>
       - unexpected value "hidden"

```

```yaml
- banner:
  - text: ▣
  - strong: Opalix
  - text: lab console running hello 01m3a42e0ez35rzhpa5t3yjc62 58:38 left
  - button "Run checks"
  - button "Snapshot"
  - button "End session"
  - button "Operator"
- main:
  - complementary:
    - heading "Checks" [level=2]
    - text: ✓ greeting-file-exists — greeting.txt matches GREETING
    - heading "Hints" [level=2]
    - paragraph: Hints unlock on a timer.
    - heading "Workspace ↻" [level=2]:
      - text: Workspace
      - button "↻"
    - list:
      - listitem: brief.md 180 B
      - listitem: greeting.txt 17 B
      - listitem: index.html 945 B
      - listitem: README.md 34 B
  - navigation:
    - button "Terminal"
    - button "Editor"
    - button "echo"
  - textbox "Terminal input"
  - complementary:
    - heading "Events 11" [level=2]
    - list:
      - listitem: 16:31:41 pressure A burst arrives — Something changed. Check the workspace.
      - listitem: 16:31:33 terminal Terminal disconnected.
      - listitem: 16:31:33 check.finished 1/1 passed
      - listitem: "16:31:33 check.result greeting-file-exists: pass"
      - listitem: "16:31:33 check.started {\"run_id\":\"01m3a43we52wvcsxq428w9x7nv\",\"total\":1}"
      - listitem: 16:31:33 check.finished 0/1 passed
      - listitem: "16:31:33 check.result greeting-file-exists: fail"
      - listitem: "16:31:33 check.started {\"run_id\":\"01m3a43mjx2xt7f6j57d8k0ev3\",\"total\":1}"
      - listitem: 16:31:33 session.state running
      - listitem: "16:31:33 service.health echo: healthy"
      - listitem: 16:31:33 session.state starting
- contentinfo:
  - text: API https://opalix-sandbox.soubenz94.workers.dev
  - button "change"
```

# Test source

```ts
  1  | import { test, expect, openConsole } from './fixtures';
  2  | 
  3  | test.describe('the operator view', () => {
  4  |   test('shows a tile per family with warm and claimed counts', async ({ page }) => {
  5  |     await openConsole(page);
  6  |     await page.locator('#btnOps').click();
  7  | 
  8  |     const tiles = page.locator('.tile');
  9  |     await expect(tiles.first()).toBeVisible({ timeout: 30_000 });
  10 |     expect(await tiles.count()).toBeGreaterThanOrEqual(2);
  11 | 
  12 |     // Counts, not collections: GET /pools reports numbers.
  13 |     await expect(tiles.first().locator('.tile-value')).toHaveText(/^\d+ warm$/);
  14 |     await expect(tiles.first().locator('.tile-sub')).toHaveText(/\d+ claimed · target \d+/);
  15 |   });
  16 | 
  17 |   test('names both families', async ({ page }) => {
  18 |     await openConsole(page);
  19 |     await page.locator('#btnOps').click();
  20 |     await expect(page.locator('.tile').first()).toBeVisible({ timeout: 30_000 });
  21 | 
  22 |     const labels = await page.locator('.tile-label').allTextContents();
  23 |     expect(labels.join(' ')).toContain('agent pool');
  24 |     expect(labels.join(' ')).toContain('gateway pool');
  25 |   });
  26 | 
  27 |   test('refuses prime and drain without a service key', async ({ page }) => {
  28 |     await openConsole(page);
  29 |     await page.locator('#btnOps').click();
> 30 |     await expect(page.locator('.tile').first()).toBeVisible({ timeout: 30_000 });
     |                                                 ^ Error: expect(locator).toBeVisible() failed
  31 | 
  32 |     // Destructive pool actions stay behind the service key even while
  33 |     // session start is open, so this must not go through.
  34 |     await page.locator('.tile').first().locator('[data-act="drain"]').click();
  35 |     await expect(page.locator('#opsKeyStatus')).toHaveText(/service key/i);
  36 |   });
  37 | 
  38 |   test('toggles back to the launcher', async ({ page }) => {
  39 |     await openConsole(page);
  40 |     await page.locator('#btnOps').click();
  41 |     await expect(page.locator('#ops')).toBeVisible();
  42 |     await page.locator('#btnOps').click();
  43 |     await expect(page.locator('#ops')).toBeHidden();
  44 |     await expect(page.locator('#launcher')).toBeVisible();
  45 |   });
  46 | });
  47 | 
```