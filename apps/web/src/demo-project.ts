import type {
  ProjectDependency,
  ProjectMember,
  ProjectState,
  ProjectTask,
} from "@vecta/application";

// Deterministic, browser-safe synthetic fixture for the client preview. It
// mirrors the backend seed (packages/persistence/src/demo-project.ts) but emits
// a ProjectState directly so the preview never pulls the persistence/pg layer
// into the browser bundle. All labels are generic and anonymized ("Phase A",
// "Product 1", "Member 01"); no client/vendor/product/contract names and no
// real values. The reference worksheet under .wbs-private/ is never read.

export interface DemoProjectOptions {
  readonly parentCount?: number;
  readonly subtasksPerParent?: number;
  readonly memberCount?: number;
  readonly seed?: number;
}

/** mulberry32 — a small, deterministic PRNG. */
function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function makeUuid(prefix: string, sequence: number): string {
  return `${prefix}0000000-0000-4000-8000-${sequence.toString(16).padStart(12, "0")}`;
}

function pick<T>(values: readonly T[], random: () => number): T {
  return values[Math.floor(random() * values.length)]!;
}

const PHASE_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const PER_DAY_MINUTES = [60, 120, 180, 240, 300, 360, 420, 480] as const;

// Two mid-week holidays early in the horizon. The scheduler skips them, so
// auto-placed rows leave those day columns empty while the seeded locked row
// (below) keeps hand-entered effort on one of them — a visible proof that a
// locked plan is preserved verbatim and a holiday leaves unlocked cells blank.
const DEMO_HOLIDAYS = ["2026-01-07", "2026-01-08"] as const;

// One deterministic locked showcase leaf (the very first subtask). Its plan is
// hand-entered — including effort on a holiday the scheduler would never fill —
// so applyEffortSchedule leaves it untouched and its FS successors shift after
// its finish. Σ daily = plannedEffortMinutes so K/M start consistent.
const LOCKED_DEMO_PLAN: Readonly<Record<string, number>> = {
  "2026-01-05": 240,
  "2026-01-06": 240,
  "2026-01-07": 180,
  "2026-01-09": 120,
};
const LOCKED_DEMO_MINUTES = Object.values(LOCKED_DEMO_PLAN).reduce((sum, value) => sum + value, 0);
const LOCKED_DEMO_START = "2026-01-05";

function buildWorkingDays(start: string, count: number): string[] {
  const days: string[] = [];
  const cursor = new Date(`${start}T00:00:00.000Z`);
  while (days.length < count) {
    const weekday = cursor.getUTCDay();
    if (weekday !== 0 && weekday !== 6) {
      days.push(cursor.toISOString().slice(0, 10));
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

export function createDemoProject(options: DemoProjectOptions = {}): ProjectState {
  const parentCount = options.parentCount ?? 300;
  const subtasksPerParent = options.subtasksPerParent ?? 9;
  const memberCount = options.memberCount ?? 40;
  const random = createRandom(options.seed ?? 0x5eed);

  const projectStart = "2026-01-05"; // a Monday
  const horizon = 260;
  const workingDays = buildWorkingDays(projectStart, horizon);
  const statusDate = workingDays[130]!;

  const members: ProjectMember[] = Array.from({ length: memberCount }, (_, index) => ({
    id: makeUuid("c", index + 1),
    name: `Member ${(index + 1).toString().padStart(2, "0")}`,
    calendarId: "standard",
    dailyCapacityMinutes: 480,
  }));

  const tasks: ProjectTask[] = [];
  let sortOrder = 0;
  let leafCounter = 0;

  for (let parentIndex = 0; parentIndex < parentCount; parentIndex += 1) {
    const parentId = makeUuid("d", parentIndex + 1);
    const phase = PHASE_LETTERS[parentIndex % PHASE_LETTERS.length];
    const product = `Product ${(parentIndex % 6) + 1}`;
    tasks.push({
      id: parentId,
      parentId: null,
      sortOrder: sortOrder++,
      name: `Phase ${phase} deliverable ${parentIndex + 1}`,
      process: `Phase ${phase}`,
      product,
      reviewRef: `REV-${(parentIndex + 1).toString().padStart(4, "0")}`,
      changeRef: `CHG-${(parentIndex + 1).toString().padStart(4, "0")}`,
      note: "",
      contract: `Contract ${(parentIndex % 4) + 1}`,
      assigneeMemberId: null,
      plannedEffortMinutes: 0,
      progressBasisPoints: 0,
      actualEffortMinutes: 0,
      prorationWeightBp: null,
      dailyPlan: {},
      dailyPlanLocked: false,
      actualStart: null,
      actualFinish: null,
      dependencies: [],
    });

    let previousLeafId: string | null = null;
    for (let subtaskIndex = 0; subtaskIndex < subtasksPerParent; subtaskIndex += 1) {
      leafCounter += 1;
      const leafId = makeUuid("e", leafCounter);
      // The first leaf of the first parent is the locked showcase row.
      const lockedDemo = parentIndex === 0 && subtaskIndex === 0;
      const span = 1 + Math.floor(random() * 8);
      const perDay = pick(PER_DAY_MINUTES, random);
      const startIndex = Math.floor(random() * (horizon - span));
      const scheduledPlan: Record<string, number> = {};
      for (let day = 0; day < span; day += 1) {
        scheduledPlan[workingDays[startIndex + day]!] = perDay;
      }
      const dailyPlan = lockedDemo ? { ...LOCKED_DEMO_PLAN } : scheduledPlan;
      const plannedEffortMinutes = lockedDemo ? LOCKED_DEMO_MINUTES : perDay * span;
      const progressBasisPoints = lockedDemo ? 4_000 : Math.floor(random() * 10_001);
      const actualEffortMinutes = Math.round(
        (plannedEffortMinutes * progressBasisPoints) / 10_000,
      );
      const actualStart = progressBasisPoints > 0 ? workingDays[startIndex]! : null;
      const actualFinish =
        progressBasisPoints >= 10_000 ? workingDays[startIndex + span - 1]! : null;
      const dependencies: ProjectDependency[] =
        previousLeafId === null
          ? []
          : [{ predecessorId: previousLeafId, type: "FS", lagWorkingDays: 0 }];

      tasks.push({
        id: leafId,
        parentId,
        sortOrder: sortOrder++,
        name: `Subtask ${parentIndex + 1}.${subtaskIndex + 1}`,
        process: `Phase ${phase}`,
        product,
        reviewRef: `REV-${(parentIndex + 1).toString().padStart(4, "0")}`,
        changeRef: `CHG-${(parentIndex + 1).toString().padStart(4, "0")}`,
        note: lockedDemo ? "Locked plan (hand-edited)" : subtaskIndex % 3 === 0 ? `Note ${leafCounter}` : "",
        contract: `Contract ${(parentIndex % 4) + 1}`,
        assigneeMemberId: members[leafCounter % memberCount]!.id,
        plannedEffortMinutes,
        progressBasisPoints,
        actualEffortMinutes,
        prorationWeightBp: null,
        dailyPlan,
        dailyPlanLocked: lockedDemo,
        actualStart: lockedDemo ? LOCKED_DEMO_START : actualStart,
        actualFinish: lockedDemo ? null : actualFinish,
        dependencies,
      });
      previousLeafId = leafId;
    }
  }

  return {
    id: makeUuid("b", 1),
    name: "Effort WBS demo",
    projectStart,
    statusDate,
    currency: "JPY",
    defaultCalendarId: "standard",
    calendars: [
      {
        id: "standard",
        name: "Standard working week",
        workingWeekdays: [1, 2, 3, 4, 5],
        nonWorkingDates: [...DEMO_HOLIDAYS],
      },
    ],
    members,
    tasks,
  };
}
