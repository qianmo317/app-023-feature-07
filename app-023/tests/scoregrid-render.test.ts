// 谱面渲染用例（jsdom + renderToStaticMarkup）：
// 散板只画每拍起始线与小节线、不画格线；角标标出散板与当前伸缩系数；时值线仍按时值比例。
// 非散板渲染结果与未接散板前保持一致（格线照常、无角标）。
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ScoreGrid } from '../src/components/ScoreGrid';
import { newEmptyScore } from '../src/lib/factory';
import { TICKS_PER_BEAT, type Step } from '../src/types';

function render(score: ReturnType<typeof newEmptyScore>, stretch?: number): string {
  return renderToStaticMarkup(
    createElement(ScoreGrid, { score, pxPerTick: 14, barsPerRow: 8, stretch }),
  );
}

function freeScore(): ReturnType<typeof newEmptyScore> {
  const score = newEmptyScore('散板谱', 4, 1);
  score.freeMeter = true;
  const gu = score.instruments[0].id;
  const glyph = score.instruments[0].glyphs[0];
  const steps: Step[] = [
    { beats: 4, hits: [{ instrumentId: gu, velocity: 2, glyph }] },
    { beats: 2, hits: [] },
    { beats: 2, hits: [{ instrumentId: gu, velocity: 2, glyph }] },
    { beats: 4, hits: [{ instrumentId: gu, velocity: 2, glyph }] },
    { beats: 4, hits: [] },
  ];
  score.bars[0].steps = steps;
  return score;
}

describe('散板谱面渲染', () => {
  it('散板：只画每拍起始线与小节线，不画格线', () => {
    const html = render(freeScore());
    expect(html).not.toContain('data-line-kind="grid"');
    // 4/4：4 条拍线（t=0,4,8,12）+ 1 条小节线（t=16）
    expect(html.match(/data-line-kind="beat"/g)?.length).toBe(4 * 1);
    expect(html.match(/data-line-kind="bar"/g)?.length).toBe(1);
  });

  it('散板：角标存在且显示当前系数，系数改变后角标跟着变', () => {
    const score = freeScore();
    expect(render(score, 1)).toContain('data-testid="grid-free-badge"');
    expect(render(score, 1)).toContain('伸缩 1.00×');
    expect(render(score, 1.5)).toContain('伸缩 1.50×');
    expect(render(score, 2)).toContain('伸缩 2.00×');
    expect(render(score, 1)).toContain('散板');
  });

  it('散板：时值线长度仍按时值比例（4 格与 2 格宽度比 2:1）', () => {
    const html = render(freeScore());
    // 时值线 stroke="#b30000"；4 格宽 = 4*14-2=54，2 格宽 = 2*14-2=26
    const redWidths = [...html.matchAll(/<line[^>]*x2="(\d+)"[^>]*stroke="#b30000"/g)].map((m) =>
      Number(m[1]) -
      Number((m[0].match(/x1="(\d+)"/) ?? [])[1] ?? 0),
    );
    expect(redWidths).toContain(54);
    expect(redWidths).toContain(26);
  });

  it('非散板：格线照常画出，且无散板角标（行为不变）', () => {
    const score = newEmptyScore('正谱', 4, 1);
    const html = render(score, 1.5); // 即使传入系数也不显示
    // 4/4 小节 17 条竖线：12 格线 + 4 拍线 + 1 小节线
    expect(html.match(/data-line-kind="grid"/g)?.length).toBe(12);
    expect(html.match(/data-line-kind="beat"/g)?.length).toBe(4);
    expect(html.match(/data-line-kind="bar"/g)?.length).toBe(1);
    expect(html).not.toContain('data-testid="grid-free-badge"');
    expect(html).not.toContain('data-free-meter="1"');
    expect(html).toContain('data-free-meter="0"');
  });

  it('每拍 4 格常量未变', () => expect(TICKS_PER_BEAT).toBe(4));
});
