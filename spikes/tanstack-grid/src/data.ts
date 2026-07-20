// Fully synthetic, code-generated data. No real client data, no spreadsheet-derived
// fixtures. Deterministic via a seeded PRNG so runs are reproducible.

export const DAY_COUNT = 90; // D+0 .. D+89 (upper bound of the 60-90 requirement)
export const META_GENERIC_COUNT = 17; // Col07 .. Col23

export interface Task {
  id: string;
  no: number;
  process: string;
  task: string;
  assignee: string;
  effort: number; // person-hours
  progress: number; // 0..100
  cols: (string | number)[]; // generic meta Col07..Col23
  days: number[]; // per-day person-hours (0 = blank)
  subRows?: Task[];
}

// mulberry32 — tiny deterministic PRNG.
function makePrng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PROCESSES = ['要件定義', '基本設計', '詳細設計', '実装', '結合試験', '総合試験', 'リリース'];
const TEAMS = ['A班', 'B班', 'C班', 'D班', 'E班', '外注1', '外注2'];

function makeDays(rand: () => number): number[] {
  const days = new Array<number>(DAY_COUNT).fill(0);
  // A contiguous work window with sparse effort inside it — looks WBS-ish.
  const start = Math.floor(rand() * (DAY_COUNT - 10));
  const len = 3 + Math.floor(rand() * 20);
  for (let i = start; i < Math.min(DAY_COUNT, start + len); i++) {
    if (rand() < 0.6) days[i] = 1 + Math.floor(rand() * 8);
  }
  return days;
}

function makeCols(rand: () => number, no: number): (string | number)[] {
  const cols: (string | number)[] = [];
  for (let c = 0; c < META_GENERIC_COUNT; c++) {
    // Alternate strings and numbers so column typing is mixed like a real sheet.
    cols.push(c % 3 === 0 ? Math.round(rand() * 100) : `R${no}-${String.fromCharCode(65 + (c % 26))}${Math.floor(rand() * 90)}`);
  }
  return cols;
}

function makeTask(rand: () => number, no: number, depth: number): Task {
  return {
    id: `t${no}`,
    no,
    process: PROCESSES[Math.floor(rand() * PROCESSES.length)],
    task: depth === 0 ? `親タスク ${no}` : `サブタスク ${no}`,
    assignee: TEAMS[Math.floor(rand() * TEAMS.length)],
    effort: 1 + Math.floor(rand() * 80),
    progress: Math.floor(rand() * 101),
    cols: makeCols(rand, no),
    days: makeDays(rand),
  };
}

/**
 * Generate a two-level WBS tree whose fully-expanded (flattened) row count is
 * exactly `targetRows`. Parents get 2-6 subtasks; the last parent is trimmed to
 * land on the target exactly.
 */
export function generateData(targetRows = 3000): { tree: Task[]; parentIds: string[] } {
  const rand = makePrng(0x5eed);
  const tree: Task[] = [];
  const parentIds: string[] = [];
  let no = 1;
  let total = 0;

  while (total < targetRows) {
    const parent = makeTask(rand, no++, 0);
    total += 1; // parent counts as a row
    parentIds.push(parent.id);

    let childCount = 2 + Math.floor(rand() * 5); // 2..6
    // Never overshoot the target.
    childCount = Math.min(childCount, targetRows - total);
    const subRows: Task[] = [];
    for (let c = 0; c < childCount; c++) {
      subRows.push(makeTask(rand, no++, 1));
      total += 1;
    }
    parent.subRows = subRows;
    tree.push(parent);
  }

  return { tree, parentIds };
}
