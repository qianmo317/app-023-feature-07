// 播放状态集中管理：AudioContext / 调度 / 循环 / 高亮位置 / 独奏静音
// UI 组件只负责显示与用户动作（保持状态逻辑集中在此 hook）
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ScheduleEvent, Score } from '../types';
import { barTicks, totalTicks } from '../lib/grid';
import { playRange, tickSeconds, type SchedulerHandle } from '../lib/audio';

export interface SoloMute {
  solo: Set<string>;
  muted: Set<string>;
}

export function useAudio(score: Score, stretch = 1) {
  const ctxRef = useRef<AudioContext | null>(null);
  const masterRef = useRef<GainNode | null>(null);
  const handleRef = useRef<SchedulerHandle | null>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState<{ bar: number; tick: number } | null>(null);
  const [loop, setLoop] = useState<{ fromBar: number; toBar: number } | null>(null); // toBar 含
  const [soloMute, setSoloMute] = useState<SoloMute>({ solo: new Set(), muted: new Set() });
  const scoreRef = useRef(score);
  scoreRef.current = score;
  const soloMuteRef = useRef(soloMute);
  soloMuteRef.current = soloMute;
  const loopRef = useRef(loop);
  loopRef.current = loop;
  const stretchRef = useRef(stretch);
  stretchRef.current = stretch;
  // 本次播放的时间轴信息（散板播放中改系数续播用）
  const runRef = useRef<{ startAt: number; fromTick: number; spanTicks: number } | null>(null);
  const stopTimerRef = useRef<number>(0);

  const ensureCtx = useCallback((): { ctx: AudioContext; master: GainNode } => {
    if (!ctxRef.current) {
      const ctx = new AudioContext();
      const master = ctx.createGain();
      master.gain.value = 0.9;
      master.connect(ctx.destination);
      ctxRef.current = ctx;
      masterRef.current = master;
      (window as unknown as { __audioCtx?: AudioContext }).__audioCtx = ctx;
    }
    return { ctx: ctxRef.current, master: masterRef.current! };
  }, []);

  const audible = useCallback((ev: ScheduleEvent): boolean => {
    const { solo, muted } = soloMuteRef.current;
    if (solo.size > 0) return solo.has(ev.instrumentId);
    return !muted.has(ev.instrumentId);
  }, []);

  const stop = useCallback(() => {
    window.clearTimeout(stopTimerRef.current);
    handleRef.current?.stop();
    handleRef.current = null;
    runRef.current = null;
    setPlaying(false);
    setPosition(null);
  }, []);

  const play = useCallback(
    (fromBar?: number) => {
      handleRef.current?.stop();
      window.clearTimeout(stopTimerRef.current);
      const { ctx, master } = ensureCtx();
      // 等待上下文真正运行后再排程：suspended 时 currentTime 冻结，预排会挤在 0 附近
      ctx
        .resume()
        .catch(() => undefined)
        .then(() => {
          const s = scoreRef.current;
          const total = totalTicks(s.bars);
          let fromTick = 0;
          let toTick = total;
          if (loopRef.current) {
            fromTick = loopRef.current.fromBar > 0 ? s.bars.slice(0, loopRef.current.fromBar).reduce((a, b) => a + barTicks(b.beatsPerBar), 0) : 0;
            const toBarIdx = Math.min(loopRef.current.toBar + 1, s.bars.length);
            toTick = s.bars.slice(0, toBarIdx).reduce((a, b) => a + barTicks(b.beatsPerBar), 0);
          }
          if (fromBar != null && fromBar > 0) fromTick = s.bars.slice(0, fromBar).reduce((a, b) => a + barTicks(b.beatsPerBar), 0);
          if (toTick <= fromTick) return;

          const visual = (ev: ScheduleEvent) => {
            if (!audible(ev)) return;
            const s2 = scoreRef.current;
            const before = s2.bars.slice(0, ev.barIndex).reduce((a, b) => a + barTicks(b.beatsPerBar), 0);
            setPosition({ bar: ev.barIndex, tick: before });
          };
          const startAt = ctx.currentTime + 0.06;
          const handle = playRange(ctx, master, s, fromTick, toTick, 1, visual, 0, stretchRef.current);
          handleRef.current = handle;
          runRef.current = { startAt, fromTick, spanTicks: toTick - fromTick };
          setPlaying(true);
          const per = tickSeconds(s.bpm) * (s.freeMeter ? stretchRef.current : 1);
          const armStop = () => {
            window.clearTimeout(stopTimerRef.current);
            stopTimerRef.current = window.setTimeout(() => {
              if (handleRef.current === handle) {
                if (loopRef.current) {
                  play();
                } else {
                  stop();
                }
              }
            }, (toTick - fromTick) * per + 250);
          };
          armStop();
          // 调试钩子：E2E 用它断言调度精度
          (window as unknown as { __scheduled?: () => ScheduleEvent[] }).__scheduled = () => handle.scheduled();
        });
    },
    [ensureCtx, audible, stop],
  );

  /** 散板播放中伸缩系数变更：已发声的一击不动，后续事件按新系数续排 */
  const retuneStretch = useCallback((next: number) => {
    const handle = handleRef.current;
    const run = runRef.current;
    const s = scoreRef.current;
    if (!handle || !run || !s.freeMeter) return;
    const nextPer = tickSeconds(s.bpm) * next;
    const { anchorTick } = handle.retune(nextPer);
    // 收尾定时器：锚点之后剩余格数按新每格秒数估算
    const remainingTicks = run.fromTick + run.spanTicks - anchorTick;
    window.clearTimeout(stopTimerRef.current);
    stopTimerRef.current = window.setTimeout(
      () => {
        if (handleRef.current === handle) {
          if (loopRef.current) play();
          else stop();
        }
      },
      Math.max(remainingTicks, 0) * nextPer * 1000 + 250,
    );
  }, [play, stop]);

  const toggleSolo = useCallback((id: string) => {
    setSoloMute((sm) => {
      const solo = new Set(sm.solo);
      const muted = new Set(sm.muted);
      if (solo.has(id)) solo.delete(id);
      else {
        solo.add(id);
        muted.delete(id);
      }
      return { solo, muted };
    });
  }, []);

  const toggleMute = useCallback((id: string) => {
    setSoloMute((sm) => {
      const solo = new Set(sm.solo);
      const muted = new Set(sm.muted);
      if (muted.has(id)) muted.delete(id);
      else {
        muted.add(id);
        solo.delete(id);
      }
      return { solo, muted };
    });
  }, []);

  useEffect(() => () => handleRef.current?.stop(), []);

  return {
    playing,
    position,
    loop,
    setLoop,
    play,
    stop,
    retuneStretch,
    soloMute,
    toggleSolo,
    toggleMute,
    ensureCtx,
  };
}
