import { DAY_COUNT, META_GENERIC_COUNT, type Task } from './data';

export const ROW_H = 30;
export const HEADER_H = 40;
export const DAY_W = 46;

export interface MetaCol {
  id: string;
  header: string;
  width: number;
  pinned: boolean;
  left: number; // absolute left within the full row (px)
  accessor: (t: Task) => string | number;
}

// ~23 meta columns: 6 named + 17 generic. The first 4 are pinned (frozen left).
const NAMED: Omit<MetaCol, 'left'>[] = [
  { id: 'no', header: 'No', width: 52, pinned: true, accessor: (t) => t.no },
  { id: 'process', header: '工程', width: 96, pinned: true, accessor: (t) => t.process },
  { id: 'task', header: 'タスク', width: 240, pinned: true, accessor: (t) => t.task },
  { id: 'assignee', header: '担当', width: 84, pinned: true, accessor: (t) => t.assignee },
  { id: 'effort', header: '工数(人時)', width: 90, pinned: false, accessor: (t) => t.effort },
  { id: 'progress', header: '進捗率', width: 72, pinned: false, accessor: (t) => `${t.progress}%` },
];

function buildMetaCols(): MetaCol[] {
  const cols: Omit<MetaCol, 'left'>[] = [...NAMED];
  for (let c = 0; c < META_GENERIC_COUNT; c++) {
    const idx = c;
    cols.push({
      id: `col${c + 7}`,
      header: `Col${String(c + 7).padStart(2, '0')}`,
      width: 74,
      pinned: false,
      accessor: (t) => t.cols[idx],
    });
  }
  let left = 0;
  return cols.map((c) => {
    const withLeft: MetaCol = { ...c, left };
    left += c.width;
    return withLeft;
  });
}

export const META_COLS: MetaCol[] = buildMetaCols();
export const PINNED_META: MetaCol[] = META_COLS.filter((c) => c.pinned);
export const SCROLL_META: MetaCol[] = META_COLS.filter((c) => !c.pinned);

export const PINNED_WIDTH = PINNED_META.reduce((s, c) => s + c.width, 0);
export const META_WIDTH = META_COLS.reduce((s, c) => s + c.width, 0);
export const DAY_REGION_WIDTH = DAY_COUNT * DAY_W;
export const TOTAL_WIDTH = META_WIDTH + DAY_REGION_WIDTH;
export const META_COL_COUNT = META_COLS.length;

// Header label for a day column (a plain date offset — no real calendar data).
const BASE = new Date(2026, 3, 1); // 2026-04-01, arbitrary synthetic anchor
export function dayHeader(i: number): string {
  const d = new Date(BASE);
  d.setDate(d.getDate() + i);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
