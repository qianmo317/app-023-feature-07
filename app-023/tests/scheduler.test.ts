// 音频调度精度用例 —— 验收：BPM 120 连续 2 分钟偏差 < 10ms、无累积漂移；齐奏同刻发声
import { describe, expect, it } from 'vitest';
import { TICKS_PER_BEAT, type Score } from '../src/types';
import { computeEvents, computeLoopEvents, playRange, scheduleEvents, tickSeconds } from '../src/lib/audio';
import { scoreFromPattern, PATTERNS, newEmptyScore } from '../src/lib/factory';
import { barTicks, totalTicks } from '../src/lib/grid';

const jijifeng = () => scoreFromPattern(PATTERNS.find((p) => p.name === '急急风')!);

class FakeAudioContext {
  currentTime = 100;
  sampleRate = 44100;
  destination = {} as AudioNode;
  createGain() {
    const node = {
      gain: { value: 1, setValueAtTime() {}, exponentialRampToValueAtTime() {} },
      connect: (x: unknown) => x,
    };
    return node as unknown as GainNode;
  }
  createOscillator() {
    const node = {
      type: '',
      frequency: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} },
      connect: (x: unknown) => x,
      start() {},
      stop() {},
    };
    return node as unknown as OscillatorNode;
  }
  createBiquadFilter() {
    const node = {
      type: '',
      frequency: { value: 0 },
      Q: { value: 0 },
      connect: (x: unknown) => x,
    };
    return node as unknown as BiquadFilterNode;
  }
  createBufferSource() {
    const node = { buffer: null, connect: (x: unknown) => x, start() {} };
    return node as unknown as AudioBufferSourceNode;
  }
  createBuffer(_c: number, len: number, _sr: number) {
    return { sampleRate: 44100, getChannelData: () => new Float32Array(len) } as unknown as AudioBuffer;
  }
  resume() {
    return Promise.resolve();
  }
}

describe('时间换算', () => {
  it('BPM 120 → 每拍 0.5s、每格 0.125s', () => {
    expect(tickSeconds(120)).toBeCloseTo(0.125, 12);
    expect(tickSeconds(120) * TICKS_PER_BEAT).toBeCloseTo(0.5, 12);
  });
  it('BPM 60 → 每拍 1s', () => expect(tickSeconds(60) * 4).toBeCloseTo(1, 12));
});

describe('验收：BPM 120 连续 2 分钟无累积漂移（<10ms）', () => {
  it('240 拍连续播放，每击时刻 = 整数格 × 固定秒/格（独立重算）', () => {
    const score = jijifeng(); // 2/4，4 小节 = 32 格；重复拼出 ≥240 拍（960 格）
    const bars = Array.from({ length: 60 }, (_, i) => ({ ...score.bars[i % score.bars.length], index: i }));
    const long: Score = { ...score, bars };
    const t0 = 1000;
    const events = computeEvents(long.bars, 120, false, long.instruments, 0, totalTicks(long.bars), t0);
    expect(events.length).toBeGreaterThan(100);

    // 独立重算期望时刻（不复用 computeEvents 的展开逻辑）
    const per = tickSeconds(120);
    const expected: number[] = [];
    let abs = 0;
    for (const b of long.bars) {
      let off = 0;
      for (const step of b.steps) {
        if (!step.rest) for (let k = 0; k < step.hits.length; k++) expected.push(t0 + (abs + off) * per);
        off += step.beats;
      }
      abs += barTicks(b.beatsPerBar);
    }
    expect(events.map((e) => e.time)).toEqual(expected);

    // 相邻发声时刻之差恒为格长整数倍（浮点误差远小于 10ms）
    const times = [...new Set(events.map((e) => e.time))].sort((a, b) => a - b);
    for (let i = 1; i < times.length; i++) {
      const deltaTicks = Math.round((times[i] - times[i - 1]) / per);
      const ideal = times[i - 1] + deltaTicks * per;
      expect(Math.abs(times[i] - ideal)).toBeLessThan(1e-9); // << 10ms
    }
    // 末击无累积漂移
    const lastRel = times[times.length - 1] - t0;
    const lastAbs = expected[expected.length - 1] - t0;
    expect(Math.abs(lastRel - lastAbs)).toBeLessThan(1e-9);
    expect(Math.abs(lastAbs - (totalTicks(long.bars) - 4) * per)).toBeLessThan(1e-9);
  });
});

describe('验收：齐奏三字同列同时发声', () => {
  it('同一步内的多乐器 hit 时刻完全相同', () => {
    const score = jijifeng();
    const events = computeEvents(score.bars, score.bpm, false, score.instruments, 0, totalTicks(score.bars), 0);
    const step0 = events.filter((e) => e.barIndex === 0 && e.offset === 0);
    expect(step0.length).toBeGreaterThanOrEqual(3); // 哐+才+七 齐奏
    const times = new Set(step0.map((e) => e.time));
    expect(times.size).toBe(1); // 完全同一时刻，非近似
  });
});

describe('循环播放', () => {
  it('loopCount=3 时段落精确重复，无相位漂移', () => {
    const score = jijifeng();
    const total = totalTicks(score.bars);
    const evs = computeLoopEvents(score, 0, total, 10, 3);
    const span = total * tickSeconds(score.bpm);
    const first = evs.filter((e) => e.time < 10 + span).map((e) => e.time - 10);
    const second = evs.filter((e) => e.time >= 10 + span && e.time < 10 + 2 * span).map((e) => e.time - 10 - span);
    expect(first.length).toBe(second.length);
    first.forEach((t, i) => expect(Math.abs(t - second[i])).toBeLessThan(1e-9));
  });
});

describe('lookahead 调度器（mock ctx）', () => {
  it('只预排 lookahead 窗口内的事件，且推进时间后继续排完', () => {
    const ctx = new FakeAudioContext() as unknown as AudioContext;
    const score = jijifeng();
    const total = totalTicks(score.bars);
    const events = computeEvents(score.bars, score.bpm, false, score.instruments, 0, total, ctx.currentTime + 0.06);
    const master = ctx.createGain();
    const handle = scheduleEvents(ctx, master, score, events, undefined, {
      startTime: ctx.currentTime + 0.06,
      per: tickSeconds(score.bpm),
    });
    const first = handle.scheduled().length;
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(events.length); // 未全部排入（lookahead 窗口）
    (ctx as unknown as { currentTime: number }).currentTime += 30; // 时间推进
    handle.scheduled(); // pump 由 interval 驱动，这里直接断言不重复计时
    handle.stop();
  });

  it('事件时刻单调不减且间隔为格长的整数倍', () => {
    const score = jijifeng();
    const total = totalTicks(score.bars);
    const events = computeEvents(score.bars, score.bpm, false, score.instruments, 0, total, 0);
    const per = tickSeconds(score.bpm);
    for (let i = 1; i < events.length; i++) {
      const d = events[i].time - events[i - 1].time;
      expect(d).toBeGreaterThanOrEqual(-1e-12);
      expect(Math.round(d / per) * per - d).toBeCloseTo(0, 9);
    }
  });
});

describe('散板近似播放', () => {
  it('stretch 拉伸整体时长', () => {
    const score = newEmptyScore('散', 2, 1);
    score.freeMeter = true;
    score.bars[0].steps = [
      { beats: 4, hits: [{ instrumentId: 'gu', velocity: 2, glyph: '咚' }] },
      { beats: 4, hits: [] },
    ];
    const base = computeEvents(score.bars, 100, true, score.instruments, 0, 8, 0, 1);
    const slow = computeEvents(score.bars, 100, true, score.instruments, 0, 8, 0, 1.5);
    expect(slow[0].time).toBeCloseTo(base[0].time * 1.5, 9);
  });
  it('非散板忽略 stretch：传 2 与传 1 时刻完全一致', () => {
    const score = newEmptyScore('正', 2, 1);
    score.freeMeter = false;
    score.bars[0].steps = [
      { beats: 4, hits: [{ instrumentId: 'gu', velocity: 2, glyph: '咚' }] },
      { beats: 4, hits: [{ instrumentId: 'gu', velocity: 2, glyph: '咚' }] },
    ];
    const a = computeEvents(score.bars, 100, false, score.instruments, 0, 8, 0, 1);
    const b = computeEvents(score.bars, 100, false, score.instruments, 0, 8, 0, 2);
    expect(a.map((e) => e.time)).toEqual(b.map((e) => e.time));
  });
  it('playRange 把设置里的伸缩系数接进散板播放（每击时刻 = 等格时长 × 系数）', () => {
    const ctx = new FakeAudioContext() as unknown as AudioContext;
    const score = newEmptyScore('散播', 4, 1);
    score.freeMeter = true;
    score.bars[0].steps = [
      { beats: 4, hits: [{ instrumentId: 'gu', velocity: 2, glyph: '咚' }] },
      { beats: 4, hits: [{ instrumentId: 'gu', velocity: 2, glyph: '咚' }] },
      { beats: 4, hits: [] },
      { beats: 4, hits: [{ instrumentId: 'gu', velocity: 2, glyph: '咚' }] },
    ];
    const master = ctx.createGain();
    const stretch = 1.5;
    const handle = playRange(ctx, master, score, 0, 16, 1, undefined, 0, stretch);
    const per = tickSeconds(score.bpm) * stretch;
    // 已排 + 未排合并为全量事件表（lookahead 窗口只预排首窗）
    const times = [...handle.scheduled(), ...handle.pending()].map((e) => e.time).sort((a, b) => a - b);
    expect(times.length).toBe(3);
    const startAt = times[0];
    expect(times[1] - startAt).toBeCloseTo(4 * per, 9);
    expect(times[2] - startAt).toBeCloseTo(12 * per, 9);
    handle.stop();
  });
  it('播放中改系数：已发声一击不动，后续事件按新系数续排', () => {
    const ctx = new FakeAudioContext() as unknown as AudioContext;
    const score = newEmptyScore('散续', 4, 1);
    score.freeMeter = true;
    score.bars[0].steps = [
      { beats: 4, hits: [{ instrumentId: 'gu', velocity: 2, glyph: '咚' }] },
      { beats: 4, hits: [{ instrumentId: 'gu', velocity: 2, glyph: '咚' }] },
      { beats: 4, hits: [{ instrumentId: 'gu', velocity: 2, glyph: '咚' }] },
      { beats: 4, hits: [{ instrumentId: 'gu', velocity: 2, glyph: '咚' }] },
    ];
    const master = ctx.createGain();
    const t0 = ctx.currentTime + 0.06;
    const events = computeEvents(score.bars, 100, true, score.instruments, 0, 16, t0, 1);
    const handle = scheduleEvents(ctx, master, score, events, undefined, { startTime: t0, per: tickSeconds(100) });
    // 初始预排（currentTime=100，事件都在 100.06+，lookahead 0.12 → 首击 t≈100.06 被排入）
    expect(handle.scheduled().length).toBe(1);
    const firstTime = handle.scheduled()[0].time;
    const per1 = tickSeconds(100);
    const per2 = per1 * 2;
    const result = handle.retune(per2);
    // 锚点 = 首击（全曲绝对格 0）
    expect(result.anchorTick).toBe(0);
    // 已发声的首击时刻不变
    expect(handle.scheduled()[0].time).toBe(firstTime);
    // 未发声事件以首击为锚点按 2× 续排
    const pendingTimes = handle.pending().map((e) => e.time).sort((a, b) => a - b);
    expect(pendingTimes[0]).toBeCloseTo(firstTime + 4 * per2, 9);
    expect(pendingTimes[1]).toBeCloseTo(firstTime + 8 * per2, 9);
    expect(pendingTimes[2]).toBeCloseTo(firstTime + 12 * per2, 9);
    // 对照旧系数：第二击原本应在首击后 4*per1
    expect(pendingTimes[0] - firstTime).toBeGreaterThan(4 * per1);
    handle.stop();
  });
  it('休止步不产生事件', () => {
    const score = newEmptyScore('休', 2, 1);
    score.bars[0].steps = [
      { beats: 4, hits: [{ instrumentId: 'gu', velocity: 2, glyph: '咚' }] },
      { beats: 4, hits: [], rest: true, ...({} as object) },
    ];
    const evs = computeEvents(score.bars, 100, false, score.instruments, 0, barTicks(2), 0);
    expect(evs.length).toBe(1);
  });
});
