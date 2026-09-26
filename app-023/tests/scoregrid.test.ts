// 谱面渲染用例 —— 散板只画拍线/小节线、角标带当前系数；非散板渲染逐字节不变
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ScoreGrid } from '../src/components/ScoreGrid';
import { newEmptyScore } from '../src/lib/factory';
import type { Score } from '../src/types';

const mkScore = (freeMeter: boolean): Score => {
  const score = newEmptyScore(freeMeter ? '散板' : '有板', 4, 1);
  score.freeMeter = freeMeter;
  score.bars[0].steps = [
    { beats: 6, hits: [{ instrumentId: 'gu', velocity: 2, glyph: '咚' }] },
    { beats: 10, hits: [] },
  ];
  return score;
};

const render = (score: Score, stretch = 1) =>
  renderToStaticMarkup(createElement(ScoreGrid, { score, pxPerTick: 10, stretch }));

const countLines = (html: string, stroke: string) =>
  (html.match(new RegExp(`<line[^>]*stroke="${stroke}"`, 'g')) ?? []).length;
const svgHeight = (html: string) => Number(html.match(/<svg[^>]* height="(\d+)"/)?.[1]);

describe('散板谱面线制', () => {
  it('非散板：每拍四格，拍线/格线/小节线全画，无散板角标', () => {
    const html = render(mkScore(false));
    expect(countLines(html, '#eee')).toBe(12); // 16 格中的 12 条格线
    expect(countLines(html, '#c9c9c9')).toBe(4); // 4 条拍线
    expect(countLines(html, '#c0392b')).toBe(1); // 末尾小节线（外框是 rect 不计）
    expect(html).not.toContain('散板');
    expect(html).not.toContain('grid-freemeter-mark');
  });

  it('散板：只画每拍起始线与小节线，不画格线', () => {
    const html = render(mkScore(true));
    expect(countLines(html, '#eee')).toBe(0); // 无格线
    expect(countLines(html, '#c9c9c9')).toBe(4); // 每拍起始线仍在
    expect(countLines(html, '#c0392b')).toBe(1); // 小节线仍在
  });

  it('散板：角落标出散板并显示当前伸缩系数，系数跟着变', () => {
    const a = render(mkScore(true), 1.25);
    expect(a).toContain('grid-freemeter-mark');
    expect(a).toContain('散板');
    expect(a).toContain('×1.25');
    const b = render(mkScore(true), 1.5);
    expect(b).toContain('×1.50');
    expect(b).not.toContain('×1.25');
  });

  it('散板：时值线长短仍按时值比例（6 格 × 10px − 2 间隙 = 58）', () => {
    for (const freeMeter of [false, true]) {
      const html = render(mkScore(freeMeter));
      const m = html.match(/<line x1="([\d.]+)"[^>]*x2="([\d.]+)"[^>]*stroke="#b30000"/);
      expect(m).toBeTruthy();
      expect(Number(m![2]) - Number(m![1])).toBeCloseTo(58, 9);
    }
  });

  it('非散板：传不同系数渲染结果逐字节一致，且无角标条高度', () => {
    const base = render(mkScore(false), 1);
    const stretched = render(mkScore(false), 1.9);
    expect(stretched).toBe(base);
    const freeH = svgHeight(render(mkScore(true)));
    const normalH = svgHeight(base);
    expect(freeH - normalH).toBe(18); // 散板角标条 18px，非散板为 0
  });
});
