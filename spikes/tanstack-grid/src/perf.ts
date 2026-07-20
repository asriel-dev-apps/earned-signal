// Browser-side performance + DOM-count instrumentation. Exposed on window so the
// Playwright acceptance harness (or a manual console session) can drive it.

export interface NodeCounts {
  rows: number;
  cells: number;
  dayCells: number;
  totalDom: number;
}

export interface ScrollResult {
  axis: 'x' | 'y';
  steps: number;
  frames: number;
  avgFrameMs: number;
  worstFrameMs: number;
  p95FrameMs: number;
  longTaskCount: number;
  worstLongTaskMs: number;
  totalLongTaskMs: number;
  finalScroll: number;
  maxScroll: number;
  nodesAfter: NodeCounts;
}

interface GridHandle {
  scroller: HTMLElement | null;
}

declare global {
  interface Window {
    __grid: GridHandle;
    __perf: {
      countNodes: () => NodeCounts;
      runScroll: (opts: { axis: 'x' | 'y'; steps?: number }) => Promise<ScrollResult>;
    };
  }
}

function countNodes(): NodeCounts {
  return {
    rows: document.querySelectorAll('[data-row]').length,
    cells: document.querySelectorAll('[data-cell]').length,
    dayCells: document.querySelectorAll('[data-daycell]').length,
    totalDom: document.querySelectorAll('*').length,
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function runScroll(opts: { axis: 'x' | 'y'; steps?: number }): Promise<ScrollResult> {
  const maybeEl = window.__grid.scroller;
  if (!maybeEl) throw new Error('grid scroller not registered');
  const el: HTMLElement = maybeEl;
  const steps = opts.steps ?? 90;
  const axis = opts.axis;

  const longTasks: number[] = [];
  let observer: PerformanceObserver | null = null;
  try {
    observer = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) longTasks.push(e.duration);
    });
    observer.observe({ entryTypes: ['longtask'] });
  } catch {
    // longtask not supported in this browser — worstLongTaskMs will be 0.
  }

  const target = axis === 'y' ? el.scrollHeight - el.clientHeight : el.scrollWidth - el.clientWidth;
  const frames: number[] = [];
  let last = performance.now();

  await new Promise<void>((resolve) => {
    let i = 0;
    function tick(now: number) {
      frames.push(now - last);
      last = now;
      const p = Math.min(1, (i + 1) / steps);
      const pos = Math.round(target * p);
      if (axis === 'y') el.scrollTop = pos;
      else el.scrollLeft = pos;
      i++;
      if (i <= steps) requestAnimationFrame(tick);
      else resolve();
    }
    requestAnimationFrame(tick);
  });

  observer?.disconnect();
  frames.shift(); // drop the first (warm-up) delta
  const sorted = [...frames].sort((a, b) => a - b);
  const sum = frames.reduce((a, b) => a + b, 0);

  return {
    axis,
    steps,
    frames: frames.length,
    avgFrameMs: +(sum / Math.max(1, frames.length)).toFixed(2),
    worstFrameMs: +Math.max(...frames).toFixed(2),
    p95FrameMs: +percentile(sorted, 95).toFixed(2),
    longTaskCount: longTasks.length,
    worstLongTaskMs: +(longTasks.length ? Math.max(...longTasks) : 0).toFixed(2),
    totalLongTaskMs: +longTasks.reduce((a, b) => a + b, 0).toFixed(2),
    finalScroll: axis === 'y' ? el.scrollTop : el.scrollLeft,
    maxScroll: target,
    nodesAfter: countNodes(),
  };
}

export function installPerf(): void {
  if (!window.__grid) window.__grid = { scroller: null };
  window.__perf = { countNodes, runScroll };
}
