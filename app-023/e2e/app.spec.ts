// E2E —— 模拟真实用户点击：建谱 → 录入 → 试听 → 调速 → 持久化 → 打印 → 性能
import { expect, test, type Page } from '@playwright/test';

async function createEmptyScore(page: Page, title: string) {
  await page.goto('#/');
  await page.getByTestId('new-title').fill(title);
  await page.getByTestId('btn-create').click();
  await expect(page.getByTestId('editor-page')).toBeVisible();
}

test.describe('曲目列表', () => {
  test('新建空白谱进入编辑器', async ({ page }) => {
    await createEmptyScore(page, 'E2E 开道锣');
    await expect(page.getByTestId('score-title')).toHaveValue('E2E 开道锣');
    await expect(page.getByTestId('grid')).toBeVisible();
  });
});

test.describe('录入与齐奏', () => {
  test('点击格子 + 键盘落字 + 数字换时值 + 休止', async ({ page }) => {
    await createEmptyScore(page, 'E2E 录入');
    // 选中 0 小节 0 格，按 z → 鼓·咚（整拍）
    await page.getByTestId('grid-cell-0-0').click();
    await page.keyboard.type('z');
    await expect(page.getByTestId('grid-glyph-0-0-gu')).toBeVisible();
    // 光标自动前进到 4 格；按 2 切半拍，再按 a → 小锣·才 落在 4 格处
    await page.keyboard.press('2');
    await page.keyboard.type('a');
    await expect(page.getByTestId('grid-glyph-0-4-xiaoluo')).toBeVisible();
    // 0 休止
    await page.keyboard.press('0');
    await page.waitForTimeout(100);
    // 齐奏：回到 0 格，v → 大锣·哐 与 咚 同列
    await page.getByTestId('grid-cell-0-0').click();
    await page.keyboard.type('v');
    await expect(page.getByTestId('grid-glyph-0-0-daluo')).toBeVisible();
  });

  test('验收：齐奏多乐器落在同一列（x 坐标相同）', async ({ page }) => {
    await createEmptyScore(page, 'E2E 齐奏');
    await page.getByTestId('grid-cell-0-0').click();
    await page.keyboard.type('z'); // 鼓
    await page.getByTestId('grid-cell-0-0').click();
    await page.keyboard.type('v'); // 大锣
    await page.getByTestId('grid-cell-0-0').click();
    await page.keyboard.type('f'); // 钹
    const xs = await page.evaluate(() => {
      const out: number[] = [];
      for (const id of ['gu', 'daluo', 'bo']) {
        const el = document.querySelector(`[data-testid="grid-glyph-0-0-${id}"] text`) as SVGTextElement | null;
        const g = el?.closest('g') as SVGGElement | null;
        if (el) {
          const bb = (g ?? el).getBoundingClientRect();
          out.push(bb.x + bb.width / 2);
        }
      }
      return out;
    });
    expect(xs.length).toBe(3);
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(1); // 同一列
  });
});

test.describe('曲牌库', () => {
  test('一键载入急急风并显示齐奏列', async ({ page }) => {
    await page.goto('#/library');
    await page.getByTestId('load-jijifeng').click();
    await expect(page.getByTestId('editor-page')).toBeVisible();
    await expect(page.getByTestId('score-title')).toHaveValue('急急风');
    await expect(page.getByTestId('grid-glyph-0-0-daluo')).toBeVisible(); // 哐
    await expect(page.getByTestId('grid-glyph-0-0-xiaoluo')).toBeVisible(); // 才
    await expect(page.getByTestId('grid-glyph-0-0-bo')).toBeVisible(); // 七
    await expect(page.locator('[data-testid="grid-bar-0"]')).toBeVisible();
  });

  test('载入收头（跨小节切分）后小节铺满', async ({ page }) => {
    await page.goto('#/library');
    await page.getByTestId('load-shutou').click();
    await expect(page.getByTestId('editor-page')).toBeVisible();
    const bars = await page.locator('[data-testid^="grid-bar-"]').count();
    expect(bars).toBe(2);
  });
});

test.describe('试听', () => {
  test('播放 → 当前拍高亮 → 停止；+/− 调 BPM', async ({ page }) => {
    await page.goto('#/library');
    await page.getByTestId('load-jijifeng').click();
    await expect(page.getByTestId('editor-page')).toBeVisible();
    await page.getByTestId('btn-play').click();
    await expect(page.getByTestId('grid-highlight')).toBeVisible({ timeout: 3000 });
    await page.getByTestId('btn-play').click(); // 停止
    await expect(page.getByTestId('grid-highlight')).toHaveCount(0);

    const bpm0 = await page.getByTestId('bpm-value').textContent();
    await page.getByTestId('bpm-up').click();
    await page.getByTestId('bpm-up').click();
    const bpm1 = Number(await page.getByTestId('bpm-value').textContent());
    expect(bpm1).toBe(Number(bpm0) + 4);
    await page.getByTestId('bpm-down').click();
    expect(Number(await page.getByTestId('bpm-value').textContent())).toBe(Number(bpm0) + 2);
  });

  test('验收：调度时刻偏差 < 10ms（读取 __scheduled 钩子）', async ({ page }) => {
    await page.goto('#/library');
    await page.getByTestId('load-jijifeng').click();
    await expect(page.getByTestId('editor-page')).toBeVisible();
    await page.getByTestId('btn-play').click();
    // 等待调度器排入足够事件（ctx resume 完成后 lookahead 持续填窗）
    await expect
      .poll(
        async () =>
          page.evaluate(
            () => (window as unknown as { __scheduled?: () => { time: number }[] }).__scheduled?.().length ?? 0,
          ),
        { timeout: 8000, intervals: [200] },
      )
      .toBeGreaterThan(10);
    const deltas = await page.evaluate(() => {
      const evs = (window as unknown as { __scheduled?: () => { time: number }[] }).__scheduled?.() ?? [];
      const uniq = [...new Set(evs.map((e) => e.time))].sort((a, b) => a - b);
      const per = 60 / 152 / 4; // 急急风 BPM 152 每格秒数
      const errs: number[] = [];
      for (let i = 1; i < uniq.length; i++) {
        const n = Math.round((uniq[i] - uniq[i - 1]) / per);
        errs.push(Math.abs(uniq[i] - uniq[i - 1] - n * per));
      }
      return errs;
    });
    expect(deltas.length).toBeGreaterThan(3);
    for (const e of deltas) expect(e).toBeLessThan(0.01); // < 10ms
    await page.getByTestId('btn-play').click();
  });

  test('独奏/静音切换', async ({ page }) => {
    await page.goto('#/library');
    await page.getByTestId('load-jijifeng').click();
    await expect(page.getByTestId('editor-page')).toBeVisible();
    await page.getByTestId('solo-daluo').click();
    await expect(page.getByTestId('solo-daluo')).toHaveClass(/on/);
    await page.getByTestId('mute-gu').click();
    await expect(page.getByTestId('mute-gu')).toHaveClass(/on/);
  });
});

test.describe('持久化', () => {
  test('刷新后曲目与谱面不丢（IndexedDB）', async ({ page }) => {
    await createEmptyScore(page, 'E2E 持久化');
    await page.getByTestId('grid-cell-0-0').click();
    await page.keyboard.type('z');
    await expect(page.getByTestId('grid-glyph-0-0-gu')).toBeVisible();
    await page.waitForTimeout(800); // 等自动保存
    await page.reload();
    await expect(page.getByTestId('editor-page')).toBeVisible();
    await expect(page.getByTestId('score-title')).toHaveValue('E2E 持久化');
    await expect(page.getByTestId('grid-glyph-0-0-gu')).toBeVisible();
  });

  test('曲目列表展示与删除', async ({ page }) => {
    await createEmptyScore(page, 'E2E 待删除');
    await page.goto('#/');
    const row = page.locator('tr', { hasText: 'E2E 待删除' });
    await expect(row).toBeVisible();
    page.once('dialog', (d) => d.accept());
    await row.getByTestId(/del-sc_/).click();
    await expect(page.locator('tr', { hasText: 'E2E 待删除' })).toHaveCount(0);
  });
});

test.describe('打印', () => {
  test('打印视图：A4 横排、简谱对照开关、打印/PNG 按钮', async ({ page }) => {
    await page.goto('#/library');
    await page.getByTestId('load-jijifeng').click();
    await expect(page.getByTestId('editor-page')).toBeVisible();
    await page.getByTestId('btn-print').click();
    await expect(page.getByTestId('print-page')).toBeVisible();
    const bars = await page.locator('[data-testid^="print-bar-"]').count();
    expect(bars).toBe(4);
    // 4 个小节一行放下（SVG 宽度 ≤ A4 内容宽 1047 + 行标）
    const w = await page.evaluate(() => (document.querySelector('[data-testid="print"]') as SVGSVGElement).width.baseVal.value);
    expect(w).toBeLessThanOrEqual(1047 + 64 + 2);
    // 简谱对照
    await page.getByTestId('chk-jianpu').check();
    await expect(page.locator('[data-testid^="print-jianpu-"]').first()).toBeVisible();
    // window.print 被调用
    await page.evaluate(() => {
      (window as unknown as { print: () => void }).print = () => {
        (window as unknown as { __printed?: boolean }).__printed = true;
      };
    });
    await page.getByTestId('btn-do-print').click();
    expect(await page.evaluate(() => (window as unknown as { __printed?: boolean }).__printed)).toBe(true);
  });
});

test.describe('设置', () => {
  test('改键位并持久化', async ({ page }) => {
    await page.goto('#/settings');
    await page.getByTestId('rebind-z').click(); // 把 z（鼓·咚）改绑到 p
    await page.keyboard.press('p');
    await expect(page.getByTestId('rebind-msg')).toContainText('已绑定 p');
    await page.waitForTimeout(300); // 等 IndexedDB 落盘
    await page.reload();
    const row = page.locator('tr', { hasText: '咚' });
    await expect(row).toContainText('p');
  });
});

test.describe('散板', () => {
  async function createFreeScore(page: Page, title: string) {
    await page.goto('#/');
    await page.getByTestId('new-title').fill(title);
    await page.getByTestId('new-free').check();
    await page.getByTestId('btn-create').click();
    await expect(page.getByTestId('editor-page')).toBeVisible();
  }

  /** React 受控 range：用原生 setter 写值再发 input 事件 */
  async function setRange(page: Page, testid: string, value: string) {
    await page.getByTestId(testid).evaluate((el, v) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, value);
  }

  test('谱面只画拍线与小节线，角落标散板与当前系数；时值线仍按时值比例', async ({ page }) => {
    await createFreeScore(page, 'E2E 散板谱面');
    // 角标：散板 + 默认系数 ×1.00
    const mark = page.getByTestId('grid-freemeter-mark');
    await expect(mark).toBeVisible();
    await expect(mark).toContainText('散板');
    await expect(mark).toContainText('×1.00');
    // 无格线（#eee），拍线（#c9c9c9）与小节线（#c0392b）仍在
    expect(await page.locator('[data-testid="grid"] line[stroke="#eee"]').count()).toBe(0);
    expect(await page.locator('[data-testid="grid"] line[stroke="#c9c9c9"]').count()).toBeGreaterThan(0);
    expect(await page.locator('[data-testid="grid"] line[stroke="#c0392b"]').count()).toBeGreaterThan(0);
    // 时值线按时值比例：半拍 2 格 × 14px − 2 间隙 = 26
    await page.getByTestId('grid-cell-0-0').click();
    await page.keyboard.press('2');
    await page.keyboard.type('z');
    const len = await page.evaluate(() => {
      const line = document.querySelector('[data-testid="grid-glyph-0-0-gu"] line[stroke="#b30000"]');
      return line ? Number(line.getAttribute('x2')) - Number(line.getAttribute('x1')) : -1;
    });
    expect(len).toBe(26);
    // 对照：非散板谱画格线、无角标
    await createEmptyScore(page, 'E2E 非散板对照');
    expect(await page.locator('[data-testid="grid"] line[stroke="#eee"]').count()).toBeGreaterThan(0);
    await expect(page.getByTestId('grid-freemeter-mark')).toHaveCount(0);
    await expect(page.getByTestId('rng-transport-stretch')).toHaveCount(0);
  });

  test('播放按等格×系数排时刻；播放中改系数按新值继续，角标跟着变', async ({ page }) => {
    await createFreeScore(page, 'E2E 散板播放');
    // 两个字相隔 4 格（BPM 100 → 每格 0.15s）
    await page.getByTestId('grid-cell-0-0').click();
    await page.keyboard.type('z');
    await page.keyboard.type('z'); // 光标自动前进 4 格后落第二个
    // 先把系数调到 1.5（未播放时角标即跟随）
    await setRange(page, 'rng-transport-stretch', '1.5');
    await expect(page.getByTestId('grid-freemeter-mark')).toContainText('×1.50');
    // 播放：两击间隔 = 4 格 × 0.15 × 1.5 = 0.9s
    await page.getByTestId('btn-play').click();
    const readDelta = () =>
      page.evaluate(() => {
        const evs = (window as unknown as { __scheduled?: () => { time: number }[] }).__scheduled?.() ?? [];
        if (evs.length < 2) return -1;
        const u = [...new Set(evs.map((e) => e.time))].sort((a, b) => a - b);
        return u[1] - u[0];
      });
    await expect.poll(readDelta, { timeout: 8000 }).toBeGreaterThan(0);
    expect(Math.abs((await readDelta()) - 0.9)).toBeLessThan(0.01);
    // 播放中改系数 → 按新值继续：间隔变为 4 × 0.15 × 0.5 = 0.3s
    await setRange(page, 'rng-transport-stretch', '0.5');
    await expect(page.getByTestId('grid-freemeter-mark')).toContainText('×0.50');
    await expect
      .poll(async () => Math.abs((await readDelta()) - 0.3) < 0.01, { timeout: 8000 })
      .toBe(true);
    await page.getByTestId('btn-play').click(); // 停止
  });
});

test.describe('性能', () => {
  test('验收：100 小节谱面滚动 ≥ 50fps', async ({ page }) => {
    await createEmptyScore(page, 'E2E 百小节');
    for (let i = 0; i < 24; i++) await page.getByRole('button', { name: '+4 小节' }).click(); // 4+96=100
    const bars = await page.locator('[data-testid^="grid-bar-"]').count();
    expect(bars).toBe(100);
    const fps = await page.evaluate(async () => {
      const scroller = document.querySelector('[data-testid="score-scroll"]') as HTMLElement;
      scroller.scrollLeft = 0;
      let frames = 0;
      const start = performance.now();
      const tick = () => {
        frames += 1;
        scroller.scrollLeft = ((performance.now() - start) / 2000) * (scroller.scrollWidth - scroller.clientWidth);
        if (performance.now() - start < 2000) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      await new Promise((r) => setTimeout(r, 2100));
      return (frames / 2) * 1; // 帧/秒
    });
    console.log('滚动 fps =', fps);
    expect(fps).toBeGreaterThanOrEqual(50);
  });
});
