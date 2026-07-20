import {
  getCoreRowModel,
  getExpandedRowModel,
  useReactTable,
  type ColumnDef,
  type ExpandedState,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  closestCenter,
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import {
  applyEffortSchedule,
  applyProjectCommand,
  listSubtaskTemplates,
  projectWbsGrid,
  type ProjectCommand,
  type ProjectState,
  type ProjectTask,
  type WbsGridProjection,
  type WbsGridTaskRow,
} from "@vecta/application";
import type { TaskStatus } from "@vecta/domain";
import { createDemoProject } from "./demo-project";
import {
  detectOverloads,
  externalMinutesFor,
  overloadKey,
  synthesizeExternalLoad,
  type ExternalLoad,
  type OverloadEntry,
} from "./cross-project-load";
import { ProjectApiError, type ProjectApiClient } from "./project-api-client";

// The grid header is two stacked rows: a grouped EVM band row (BAND_H) on top of
// the existing column-name row (HEAD_NAME_H). HEADER_H is their sum so the
// row/day virtualizers' paddingStart keeps rows/day cells clear of the header.
const BAND_H = 22;
const HEAD_NAME_H = 46;
const HEADER_H = BAND_H + HEAD_NAME_H;
const ROW_H = 30;
const DAILY_COL_W = 48;

type ColKind =
  | "index"
  | "text"
  | "assignee"
  | "hours"
  | "progress"
  | "date"
  | "derivedNum"
  | "derivedPercent"
  | "derivedDate"
  | "status";

/** EVM band a meta column groups under in the 2-row header (color set in CSS). */
type BandId = "estimate" | "bac" | "pv" | "ev" | "ac" | "cv";

const BAND_LABEL: Record<BandId, string> = {
  estimate: "見積り",
  bac: "BAC",
  pv: "PV",
  ev: "EV",
  ac: "AC",
  cv: "CV",
};

const SUBTASK_TEMPLATES = listSubtaskTemplates();

interface MetaColumn {
  readonly id: string;
  readonly header: string;
  readonly width: number;
  readonly pinned: boolean;
  readonly editable: boolean;
  readonly kind: ColKind;
  /** Stored input field edited by this column (editable columns only). */
  readonly field?: keyof WbsGridTaskRow;
  /** EVM band this column groups under in the 2-row header (no band = blank). */
  readonly band?: BandId;
}

// Japanese column headers follow the source worksheet. Numeric EVM columns spell
// out the metric in Japanese with its unit in parentheses; the PV/EV/AC/CV
// abbreviations survive in the grouped header bands and the top totals strip.
const META: readonly MetaColumn[] = [
  { id: "no", header: "No.", width: 72, pinned: true, editable: false, kind: "index" },
  { id: "process", header: "工程", width: 104, pinned: true, editable: true, kind: "text", field: "process" },
  { id: "name", header: "タスク・サブタスク", width: 240, pinned: true, editable: true, kind: "text", field: "name" },
  { id: "assignee", header: "担当", width: 120, pinned: true, editable: true, kind: "assignee", field: "assigneeMemberId" },
  { id: "product", header: "プロダクト", width: 108, pinned: false, editable: true, kind: "text", field: "product" },
  { id: "note", header: "備考", width: 140, pinned: false, editable: true, kind: "text", field: "note" },
  { id: "contract", header: "契約", width: 96, pinned: false, editable: true, kind: "text", field: "contract" },
  { id: "plannedEffortDays", header: "工数(人日)", width: 92, pinned: false, editable: false, kind: "derivedNum", band: "estimate" },
  { id: "plannedEffortMinutes", header: "工数(人時)", width: 92, pinned: false, editable: true, kind: "hours", field: "plannedEffortMinutes", band: "estimate" },
  { id: "plannedEffortHours", header: "計画工数(人時)", width: 108, pinned: false, editable: false, kind: "derivedNum", band: "bac" },
  { id: "plannedEarnedHours", header: "計画進捗工数(人時)", width: 116, pinned: false, editable: false, kind: "derivedNum", band: "pv" },
  { id: "plannedProgress", header: "進捗率(計画)", width: 96, pinned: false, editable: false, kind: "derivedPercent", band: "pv" },
  { id: "plannedStart", header: "開始予定", width: 92, pinned: false, editable: false, kind: "derivedDate", band: "pv" },
  { id: "plannedFinish", header: "終了予定", width: 92, pinned: false, editable: false, kind: "derivedDate", band: "pv" },
  { id: "actualStart", header: "開始日", width: 88, pinned: false, editable: true, kind: "date", field: "actualStart", band: "ev" },
  { id: "actualFinish", header: "終了日", width: 88, pinned: false, editable: true, kind: "date", field: "actualFinish", band: "ev" },
  { id: "progress", header: "進捗率", width: 84, pinned: false, editable: true, kind: "progress", field: "progressBasisPoints", band: "ev" },
  { id: "status", header: "ステータス", width: 96, pinned: false, editable: false, kind: "status", band: "ev" },
  { id: "earnedEffortHours", header: "実績進捗工数(人時)", width: 116, pinned: false, editable: false, kind: "derivedNum", band: "ev" },
  { id: "actualEffortMinutes", header: "実績投入工数(人時)", width: 116, pinned: false, editable: true, kind: "hours", field: "actualEffortMinutes", band: "ac" },
  { id: "costVarianceHours", header: "コスト差異(人時)", width: 108, pinned: false, editable: false, kind: "derivedNum", band: "cv" },
];

const PINNED = META.filter((column) => column.pinned);
const NON_PINNED = META.filter((column) => !column.pinned);
const PINNED_WIDTH = PINNED.reduce((sum, column) => sum + column.width, 0);
const META_WIDTH = PINNED_WIDTH + NON_PINNED.reduce((sum, column) => sum + column.width, 0);
// Column an "Add task" click lands the selection on, so the new row is ready
// for an immediate inline-edit of its name.
const NAME_COL_INDEX = META.findIndex((column) => column.id === "name");

const NON_PINNED_LEFT: readonly number[] = (() => {
  const offsets: number[] = [];
  let cursor = PINNED_WIDTH;
  for (const column of NON_PINNED) {
    offsets.push(cursor);
    cursor += column.width;
  }
  return offsets;
})();

interface BandGroup {
  readonly id: BandId;
  readonly label: string;
  readonly left: number;
  readonly width: number;
}

// Contiguous same-band non-pinned columns collapse into one header band. `left`
// is the left edge of the group's first column and `width` the sum of its
// columns' widths, so each band lines up exactly over the column-name cells below
// it — derived from the column widths, never hardcoded. Every banded column lives
// in the NON_PINNED region, so band cells position like the non-pinned name cells.
const BANDS: readonly BandGroup[] = (() => {
  const groups: { id: BandId; label: string; left: number; width: number }[] = [];
  NON_PINNED.forEach((column, index) => {
    const band = column.band;
    if (band === undefined) return;
    const left = NON_PINNED_LEFT[index]!;
    const previous = groups[groups.length - 1];
    if (previous !== undefined && previous.id === band && previous.left + previous.width === left) {
      previous.width += column.width;
    } else {
      groups.push({ id: band, label: BAND_LABEL[band], left, width: column.width });
    }
  });
  return groups;
})();

const STATUS_LABEL: Record<TaskStatus, string> = {
  NOT_STARTED: "未着手",
  IN_PROGRESS: "着手中",
  DONE: "完了",
};

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function processHue(process: string): number {
  let hash = 0;
  for (let index = 0; index < process.length; index += 1) {
    hash = (hash * 31 + process.charCodeAt(index)) | 0;
  }
  return Math.abs(hash) % 360;
}

/**
 * ISO weekday (1=Mon … 7=Sun) of an ISO date, computed deterministically in UTC
 * so it never depends on the runtime's local timezone. Matches the domain
 * scheduler's own weekday convention (`workingWeekdays` uses 1=Mon..7=Sun).
 */
function isoWeekday(date: string): number {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0=Sun … 6=Sat
  return day === 0 ? 7 : day;
}

type ViewMode = "flat" | "tree";

/**
 * A grid row augmented with `subRows` for TanStack's expanded row model. In tree
 * mode the flat projection rows are nested under their `parentId`; flat mode
 * feeds the projection rows straight through (no `subRows`, so every row is
 * depth 0). The tree engine (TanStack Table `getExpandedRowModel`) is the same
 * one validated in the grid spike (FINDINGS §"ツリー階層").
 */
type TreeRow = WbsGridTaskRow & { readonly subRows?: readonly TreeRow[] };

export interface DragData {
  readonly id: string;
  readonly parentId: string | null;
  readonly name: string;
}

/** dnd-kit listeners/attributes, derived so no internal type is imported. */
type DragListeners = ReturnType<typeof useDraggable>["listeners"];
type DragAttributes = ReturnType<typeof useDraggable>["attributes"];

interface NameCellTree {
  readonly depth: number;
  readonly canExpand: boolean;
  readonly isExpanded: boolean;
  readonly onToggleExpand: () => void;
  readonly dragRef?: ((element: HTMLElement | null) => void) | undefined;
  readonly dragListeners?: DragListeners | undefined;
  readonly dragAttributes?: DragAttributes | undefined;
}

/**
 * Nest the flat, sort-ordered projection rows into a `parentId` tree. Children
 * keep their source order because `rows` is already sorted by (sortOrder, id),
 * and a child whose parent is missing is promoted to a root so no row is lost.
 */
function buildTree(rows: readonly WbsGridTaskRow[]): TreeRow[] {
  const nodes = new Map<string, TreeRow & { subRows: TreeRow[] }>();
  for (const row of rows) nodes.set(row.id, { ...row, subRows: [] });
  const roots: TreeRow[] = [];
  for (const row of rows) {
    const node = nodes.get(row.id)!;
    const parent = row.parentId === null ? undefined : nodes.get(row.parentId);
    if (parent === undefined) roots.push(node);
    else parent.subRows.push(node);
  }
  return roots;
}

/**
 * Decide the new parent for a drag re-parent, or null when the drop is a no-op
 * or illegal. Dropping row A onto row B nests A under B, except when B is A
 * itself, B is already A's parent, or B lives inside A's subtree (which would
 * create a cycle). This mirrors the domain's `validateParentHierarchy`
 * (self-parent + acyclic) so the client rejects the same drops the server does.
 */
export function resolveReparentTarget(
  active: DragData,
  over: DragData,
  isWithinActiveSubtree: (candidateId: string) => boolean,
): string | null {
  if (over.id === active.id) return null;
  if (over.id === active.parentId) return null;
  if (isWithinActiveSubtree(over.id)) return null;
  return over.id;
}

/**
 * The `task.update` re-parent command a drop should dispatch, or null when the
 * drop is a no-op / illegal. This is the exact command sent through the shared
 * `executeCommand` plumbing, so the drag path reuses the same save/reload/
 * conflict handling as every inline edit.
 */
export function reparentCommand(
  active: DragData,
  over: DragData,
  isWithinActiveSubtree: (candidateId: string) => boolean,
): ProjectCommand | null {
  const newParentId = resolveReparentTarget(active, over, isWithinActiveSubtree);
  return newParentId === null
    ? null
    : { type: "task.update", taskId: active.id, changes: { parentId: newParentId } };
}

/**
 * Per-row dnd wrapper. It calls the draggable/droppable hooks once per rendered
 * row (rules of hooks) and hands their refs/listeners to a render prop, so the
 * heavy row markup stays inline in `App` with direct access to grid state. The
 * hooks are `disabled` in flat mode, and the enclosing `DndContext` stays
 * mounted across the flat⇄tree toggle (spike gotcha #2: never remount it).
 */
function DndRow({
  id,
  parentId,
  name,
  enabled,
  children,
}: {
  readonly id: string;
  readonly parentId: string | null;
  readonly name: string;
  readonly enabled: boolean;
  readonly children: (bag: {
    readonly dropRef?: ((element: HTMLElement | null) => void) | undefined;
    readonly dragRef?: ((element: HTMLElement | null) => void) | undefined;
    readonly dragListeners?: DragListeners | undefined;
    readonly dragAttributes?: DragAttributes | undefined;
    readonly isOver: boolean;
  }) => ReactNode;
}): ReactNode {
  const data: DragData = { id, parentId, name };
  const draggable = useDraggable({ id: `drag-${id}`, data, disabled: !enabled });
  const droppable = useDroppable({ id: `drop-${id}`, data, disabled: !enabled });
  return children({
    dropRef: enabled ? droppable.setNodeRef : undefined,
    dragRef: enabled ? draggable.setNodeRef : undefined,
    dragListeners: enabled ? draggable.listeners : undefined,
    dragAttributes: enabled ? draggable.attributes : undefined,
    isOver: enabled && droppable.isOver,
  });
}

function displayValue(column: MetaColumn, row: WbsGridTaskRow, index: number): string {
  switch (column.kind) {
    case "index":
      return String(index + 1);
    case "text":
      return String(row[column.field as keyof WbsGridTaskRow] ?? "");
    case "assignee":
      return row.assigneeName ?? "";
    case "hours":
      return formatNumber((row[column.field as keyof WbsGridTaskRow] as number) / 60);
    case "progress":
      return row.progress.toFixed(2);
    case "date":
      return String(row[column.field as keyof WbsGridTaskRow] ?? "");
    case "derivedNum":
      return formatNumber(row[column.id as keyof WbsGridTaskRow] as number);
    case "derivedPercent":
      return `${(row.plannedProgress * 100).toFixed(0)}%`;
    case "derivedDate":
      return String(row[column.id as keyof WbsGridTaskRow] ?? "");
    case "status":
      return STATUS_LABEL[row.status];
  }
}

function editInitialValue(column: MetaColumn, row: WbsGridTaskRow): string {
  switch (column.kind) {
    case "hours":
      return String((row[column.field as keyof WbsGridTaskRow] as number) / 60);
    case "progress":
      return row.progress.toFixed(2);
    case "assignee":
      return row.assigneeMemberId ?? "";
    case "date":
      return String(row[column.field as keyof WbsGridTaskRow] ?? "");
    default:
      return String(row[column.field as keyof WbsGridTaskRow] ?? "");
  }
}

/** Parse an editor value into a task.update change set, or null when malformed. */
function buildChanges(
  column: MetaColumn,
  raw: string,
): Partial<Omit<ProjectTask, "id">> | null {
  const trimmed = raw.trim();
  switch (column.id) {
    case "plannedEffortMinutes": {
      const hours = Number(trimmed);
      if (!Number.isFinite(hours) || hours < 0) return null;
      return { plannedEffortMinutes: Math.round(hours * 60) };
    }
    case "actualEffortMinutes": {
      const hours = Number(trimmed);
      if (!Number.isFinite(hours) || hours < 0) return null;
      return { actualEffortMinutes: Math.round(hours * 60) };
    }
    case "progress": {
      const fraction = Number(trimmed);
      if (!Number.isFinite(fraction)) return null;
      return { progressBasisPoints: Math.round(fraction * 10_000) };
    }
    case "actualStart":
      return { actualStart: trimmed === "" ? null : trimmed };
    case "actualFinish":
      return { actualFinish: trimmed === "" ? null : trimmed };
    case "assignee":
      return { assigneeMemberId: trimmed === "" ? null : trimmed };
    case "process":
      return { process: raw };
    case "product":
      return { product: raw };
    case "name":
      return { name: raw };
    case "note":
      return { note: raw };
    case "contract":
      return { contract: raw };
    default:
      return null;
  }
}

type SaveState = "preview" | "loading" | "saved" | "saving" | "error";

interface CellAddress {
  readonly rowIndex: number;
  readonly colIndex: number;
}

interface DailyCellAddress {
  readonly rowId: string;
  readonly date: string;
}

/**
 * Build the task.update change set for a hand edit of one daily cell. Every daily
 * cell is hand-edited now (Design 0003 §C-2: no lock concept), so the edit simply
 * writes the full replacement plan. Returns null when the entered hours are
 * malformed. A zero clears the day.
 */
function buildDailyPlanChange(
  row: WbsGridTaskRow,
  date: string,
  raw: string,
): Partial<Omit<ProjectTask, "id">> | null {
  const hours = Number(raw.trim());
  if (!Number.isFinite(hours) || hours < 0) return null;
  const minutes = Math.round(hours * 60);
  const dailyPlan: Record<string, number> = { ...row.dailyPlan };
  if (minutes === 0) delete dailyPlan[date];
  else dailyPlan[date] = minutes;
  return { dailyPlan };
}

const EMPTY_PROJECT: ProjectState = {
  id: "00000000-0000-4000-8000-000000000000",
  name: "",
  projectStart: "2026-01-01",
  statusDate: "2026-01-01",
  currency: "JPY",
  defaultCalendarId: "standard",
  calendars: [{ id: "standard", name: "Standard", workingWeekdays: [1, 2, 3, 4, 5], nonWorkingDates: [] }],
  members: [],
  tasks: [],
};

/** Fixed localStorage key/version for the preview-only persistence below (exported for tests). */
export const PREVIEW_STORAGE_KEY = "vecta-preview-state-v1";
export const PREVIEW_STORAGE_VERSION = 1;

interface PreviewStorageEnvelope {
  readonly version: number;
  readonly project: ProjectState;
}

function isPreviewStorageEnvelope(value: unknown): value is PreviewStorageEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { version?: unknown; project?: unknown };
  if (candidate.version !== PREVIEW_STORAGE_VERSION) return false;
  if (typeof candidate.project !== "object" || candidate.project === null) return false;
  const project = candidate.project as { id?: unknown; tasks?: unknown };
  return typeof project.id === "string" && Array.isArray(project.tasks);
}

/**
 * Preview-only persistence. With no backend (client === undefined), a reload
 * would otherwise lose every hand-added/edited task, so preview mutations are
 * mirrored to localStorage and reloaded on the next mount. Reads/writes are
 * wrapped in try/catch so disabled or full storage (private browsing, quota)
 * degrades to "preview simply doesn't persist" instead of crashing the app,
 * and a corrupt or version-mismatched payload falls back to the demo baseline
 * rather than feeding a malformed ProjectState into the grid.
 */
function loadPreviewProject(): ProjectState | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(PREVIEW_STORAGE_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return isPreviewStorageEnvelope(parsed) ? parsed.project : null;
  } catch {
    return null;
  }
}

function savePreviewProject(project: ProjectState): void {
  if (typeof localStorage === "undefined") return;
  try {
    const envelope: PreviewStorageEnvelope = { version: PREVIEW_STORAGE_VERSION, project };
    localStorage.setItem(PREVIEW_STORAGE_KEY, JSON.stringify(envelope));
  } catch {
    // Storage unavailable or full — preview edits simply aren't persisted.
  }
}

function clearPreviewProject(): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(PREVIEW_STORAGE_KEY);
  } catch {
    // Storage unavailable — nothing to clear.
  }
}

function demoProjectScheduled(): ProjectState {
  // The preview's initial daily plot is generated once by the same deterministic
  // scheduler the server runs (Design 0003 §C-2): every leaf is placed honoring
  // dependencies, capacity, and holidays. This is the one-shot baseline only —
  // after load, every daily/estimate value is hand-edited and nothing re-places.
  return applyEffortSchedule(createDemoProject());
}

export function App({ client }: { readonly client?: ProjectApiClient }) {
  const [project, setProject] = useState<ProjectState>(() => {
    if (client !== undefined) return EMPTY_PROJECT;
    // Preview: reuse whatever was last saved to localStorage so a reload keeps
    // hand-added/edited tasks with no backend; fall back to the scheduled demo
    // baseline when nothing is stored yet (or storage is corrupt/unreadable).
    return loadPreviewProject() ?? demoProjectScheduled();
  });
  const [grid, setGrid] = useState<WbsGridProjection>(() => projectWbsGrid(project));
  const [revision, setRevision] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>(client === undefined ? "preview" : "loading");
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<CellAddress>({ rowIndex: 0, colIndex: 0 });
  const [editing, setEditing] = useState<CellAddress | null>(null);
  const [editValue, setEditValue] = useState("");
  const [dailyEditing, setDailyEditing] = useState<DailyCellAddress | null>(null);
  const [dailyEditValue, setDailyEditValue] = useState("");
  const [templateId, setTemplateId] = useState<string>(SUBTASK_TEMPLATES[0]?.id ?? "");
  const [viewMode, setViewMode] = useState<ViewMode>("flat");
  // Feature #6: overlay each assignee's other-project daily load behind the day
  // columns and flag the days where this-project + other-project effort exceeds
  // the member's daily capacity. Default on so the cross-project signal is
  // visible; the toggle returns the grid to its plain day-plot view.
  const [showExternalLoad, setShowExternalLoad] = useState(true);
  // Expanded state. Default `true` = every parent expanded (the spike's initial
  // all-expanded worst case), independent of async load timing; a per-row
  // collapse or "Collapse all" narrows it to a record.
  const [expanded, setExpanded] = useState<ExpandedState>(true);
  const [activeDrag, setActiveDrag] = useState<DragData | null>(null);
  // Id of a just-added task awaiting its first appearance in `modelRows`, so it
  // can be selected (and scrolled to) once the grid re-renders with it.
  const [pendingAddedTaskId, setPendingAddedTaskId] = useState<string | null>(null);
  const saving = useRef(false);
  const scrollerRef = useRef<HTMLDivElement>(null);

  const rows = grid.rows as WbsGridTaskRow[];
  const editable = saveState === "preview" || saveState === "saved";

  const memberOptions = useMemo(
    () => project.members.map((member) => ({ id: member.id, name: member.name })),
    [project.members],
  );

  // Continuous calendar axis: every ISO date from the first to the last planned
  // day inclusive, so weekends/holidays appear as columns (greyed, non-editable
  // by the shared-non-working test below) rather than being skipped. Empty when
  // no task carries a plan yet.
  const days = useMemo(() => {
    let min: string | null = null;
    let max: string | null = null;
    for (const row of rows) {
      for (const date of Object.keys(row.dailyPlan)) {
        if (min === null || date < min) min = date;
        if (max === null || date > max) max = date;
      }
    }
    if (min === null || max === null) return [];
    const result: string[] = [];
    const cursor = new Date(`${min}T00:00:00Z`);
    const end = new Date(`${max}T00:00:00Z`);
    while (cursor.getTime() <= end.getTime()) {
      result.push(cursor.toISOString().slice(0, 10));
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return result;
  }, [rows]);

  // The sparse set of dates that actually carry a plan (the "planning days").
  // The cross-project load/overload signal is computed over these, not the full
  // calendar axis, so weekend/holiday columns never manufacture load, and the
  // synthetic seam stays identical to the pre-continuous-axis behaviour.
  const planDays = useMemo(() => {
    const set = new Set<string>();
    for (const row of rows) {
      for (const date of Object.keys(row.dailyPlan)) set.add(date);
    }
    return [...set].sort();
  }, [rows]);

  // Non-working-day model for the daily plot. Two O(1) lookups are built once per
  // project change and reused per cell (never re-scanning nonWorkingDates per
  // cell): `calendarsById` resolves a calendar id to {weekdays, holidays} sets,
  // and `memberCalendarId` resolves a row's assignee to its calendar id. The
  // project default calendar drives the *shared* weekend/holiday state.
  const defaultCalendar = useMemo(
    () => project.calendars.find((calendar) => calendar.id === project.defaultCalendarId),
    [project.calendars, project.defaultCalendarId],
  );
  const calendarsById = useMemo(() => {
    const map = new Map<string, { workingWeekdays: Set<number>; nonWorkingDates: Set<string> }>();
    for (const calendar of project.calendars) {
      map.set(calendar.id, {
        workingWeekdays: new Set(calendar.workingWeekdays),
        nonWorkingDates: new Set(calendar.nonWorkingDates),
      });
    }
    return map;
  }, [project.calendars]);
  const memberCalendarId = useMemo(() => {
    const map = new Map<string, string>();
    for (const member of project.members) map.set(member.id, member.calendarId);
    return map;
  }, [project.members]);
  // The subset of visible day columns that are shared non-working days (weekend
  // per the default calendar's workingWeekdays, or a default-calendar holiday).
  // Greyed and non-editable in every row. Computed over `days` (O(days)) so the
  // per-cell test is a single Set lookup.
  const sharedNonWorkingDates = useMemo(() => {
    const set = new Set<string>();
    if (defaultCalendar === undefined) return set;
    const working = new Set(defaultCalendar.workingWeekdays);
    const holidays = new Set(defaultCalendar.nonWorkingDates);
    for (const date of days) {
      if (!working.has(isoWeekday(date)) || holidays.has(date)) set.add(date);
    }
    return set;
  }, [days, defaultCalendar]);
  // Paid-leave (有給 / individual non-working) test for one row's assignee on one
  // date: the assignee-calendar lists it as non-working, but it is not already a
  // shared weekend/holiday (which takes visual precedence). O(1) per call.
  const isPaidLeave = useCallback(
    (assigneeMemberId: string | null, date: string): boolean => {
      if (assigneeMemberId === null || sharedNonWorkingDates.has(date)) return false;
      const calendarId = memberCalendarId.get(assigneeMemberId);
      if (calendarId === undefined) return false;
      const calendar = calendarsById.get(calendarId);
      return calendar !== undefined && calendar.nonWorkingDates.has(date);
    },
    [calendarsById, memberCalendarId, sharedNonWorkingDates],
  );

  // Feature #6 — cross-project load. `externalLoad` is the synthetic "other PJ"
  // daily commitment behind the seam (swapped for a real read in Phase 2); it is
  // always computed but only surfaced when the toggle is on. `overloads` are the
  // (member, date) pairs whose this-project + other-project total exceeds the
  // member's daily capacity, keyed for O(1) day-cell lookup and named for the
  // summary breakdown.
  const externalLoad = useMemo<ExternalLoad>(
    () => synthesizeExternalLoad(project.members, planDays),
    [project.members, planDays],
  );
  const capacityByMember = useMemo(() => {
    const map = new Map<string, number>();
    for (const member of project.members) {
      if (typeof member.dailyCapacityMinutes === "number") map.set(member.id, member.dailyCapacityMinutes);
    }
    return map;
  }, [project.members]);
  const overloads = useMemo<OverloadEntry[]>(
    () =>
      showExternalLoad
        ? detectOverloads({ rows, external: externalLoad, members: project.members })
        : [],
    [showExternalLoad, rows, externalLoad, project.members],
  );
  const overloadByKey = useMemo(() => {
    const map = new Map<string, OverloadEntry>();
    for (const entry of overloads) map.set(overloadKey(entry.memberId, entry.date), entry);
    return map;
  }, [overloads]);
  const overloadSummary = useMemo(() => {
    if (overloads.length === 0) return null;
    const nameById = new Map(project.members.map((member) => [member.id, member.name]));
    const lines = overloads.slice(0, 8).map((entry) => {
      const name = nameById.get(entry.memberId) ?? entry.memberId;
      return `${name} · ${entry.date.slice(5)}  +${formatNumber(entry.overflowMinutes / 60)}h 超過（本PJ ${formatNumber(entry.projectMinutes / 60)}h + 他PJ ${formatNumber(entry.externalMinutes / 60)}h ＞ 上限 ${formatNumber(entry.capacityMinutes / 60)}h）`;
    });
    const remainder = overloads.length - lines.length;
    const title = remainder > 0 ? `${lines.join("\n")}\n…ほか ${remainder} 件` : lines.join("\n");
    return { count: overloads.length, title };
  }, [overloads, project.members]);

  // Design 0003 §C-2 — non-blocking, row-level validation. A row is flagged when
  // its estimate disagrees with its children (親≠Σ子) or its daily plot
  // (見積≠Σ日別), or when its assignee is capacity-overloaded on a day this row
  // plans effort. Purely derived; saving is never blocked — the warning just
  // tells a person which check to reconcile by hand. `title` joins the reasons.
  const rowWarningById = useMemo(() => {
    const map = new Map<string, { readonly title: string }>();
    for (const row of rows) {
      const reasons: string[] = [];
      if (row.parentEffortMismatch) reasons.push("親タスクの工数(人時)が子タスクの合計と一致していません");
      if (row.estimateVsDailyMismatch) reasons.push("工数(人時)の見積が日別計画の合計と一致していません");
      const assignee = row.assigneeMemberId;
      if (assignee !== null && overloadByKey.size > 0) {
        for (const [date, minutes] of Object.entries(row.dailyPlan)) {
          if (minutes > 0 && overloadByKey.has(overloadKey(assignee, date))) {
            reasons.push("担当者の合計工数がキャパを超過している日があります");
            break;
          }
        }
      }
      if (reasons.length > 0) map.set(row.id, { title: reasons.join("\n") });
    }
    return map;
  }, [rows, overloadByKey]);

  // For each row, the immediately-preceding/following sibling id (same parentId),
  // or null at a group edge. `rows` is already sorted by (sortOrder, id) — the
  // same order the projection renders and the tree nests — so grouping by
  // parentId preserves each sibling run's display order. Powers the row reorder
  // controls: "move up" swaps sortOrder with prevId, "move down" with nextId, and
  // an edge (null) disables the button.
  const siblingBounds = useMemo(() => {
    const byParent = new Map<string | null, WbsGridTaskRow[]>();
    for (const row of rows) {
      const group = byParent.get(row.parentId) ?? [];
      group.push(row);
      byParent.set(row.parentId, group);
    }
    const bounds = new Map<string, { prevId: string | null; nextId: string | null }>();
    for (const group of byParent.values()) {
      group.forEach((row, index) => {
        bounds.set(row.id, {
          prevId: index > 0 ? group[index - 1]!.id : null,
          nextId: index < group.length - 1 ? group[index + 1]!.id : null,
        });
      });
    }
    return bounds;
  }, [rows]);

  const treeMode = viewMode === "tree";
  const treeData = useMemo(() => buildTree(rows), [rows]);
  // Tree mode nests rows under parentId; flat mode feeds the projection rows
  // straight through (no subRows ⇒ every row depth 0, sort-order sequence).
  const data: TreeRow[] = treeMode ? treeData : (rows as TreeRow[]);

  const columns = useMemo<ColumnDef<TreeRow>[]>(
    () => META.map((column) => ({ id: column.id, header: column.header, accessorKey: "id" })),
    [],
  );
  const table = useReactTable({
    data,
    columns,
    state: { expanded },
    onExpandedChange: setExpanded,
    getSubRows: (row) => row.subRows as TreeRow[] | undefined,
    getRowId: (row) => row.id,
    getCoreRowModel: getCoreRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
  });
  // In tree mode this is the expanded/visible set (collapsed subtrees drop out),
  // so the row virtualizer window shrinks with collapse; in flat mode it is the
  // full sort-ordered list. Selection/edit indices address this display order.
  const modelRows = table.getRowModel().rows;

  // parentId → child ids, for the acyclic drop guard (target must not sit inside
  // the dragged row's own subtree). Built from the full projection, not the
  // visible set, so a collapsed descendant still blocks an illegal drop.
  const childrenByParentId = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const row of rows) {
      if (row.parentId === null) continue;
      const siblings = map.get(row.parentId) ?? [];
      siblings.push(row.id);
      map.set(row.parentId, siblings);
    }
    return map;
  }, [rows]);

  const collectSubtree = useCallback(
    (id: string): Set<string> => {
      const found = new Set<string>();
      const stack = [...(childrenByParentId.get(id) ?? [])];
      while (stack.length > 0) {
        const current = stack.pop()!;
        if (found.has(current)) continue;
        found.add(current);
        for (const child of childrenByParentId.get(current) ?? []) stack.push(child);
      }
      return found;
    },
    [childrenByParentId],
  );

  // initialRect seeds the viewport before the browser measures the scroller on
  // the first frame; a no-layout environment (e.g. tests) falls back to it.
  const rowVirtualizer = useVirtualizer({
    count: modelRows.length,
    getScrollElement: () => scrollerRef.current,
    estimateSize: () => ROW_H,
    overscan: 12,
    paddingStart: HEADER_H,
    initialRect: { width: 1440, height: 720 },
  });
  const dayVirtualizer = useVirtualizer({
    horizontal: true,
    count: days.length,
    getScrollElement: () => scrollerRef.current,
    estimateSize: () => DAILY_COL_W,
    overscan: 6,
    paddingStart: META_WIDTH,
    initialRect: { width: 1440, height: 720 },
  });

  const reload = useCallback(async () => {
    if (client === undefined) return;
    const [workspace, gridDocument] = await Promise.all([client.load(), client.grid()]);
    setProject(workspace.current);
    setGrid(gridDocument);
    setRevision(workspace.revision);
  }, [client]);

  useEffect(() => {
    if (client === undefined) return;
    let active = true;
    setSaveState("loading");
    reload()
      .then(() => { if (active) setSaveState("saved"); })
      .catch((error: unknown) => {
        if (!active) return;
        setSaveState("error");
        setNotice(error instanceof Error ? error.message : "The project could not be loaded");
      });
    return () => { active = false; };
  }, [client, reload]);

  useEffect(() => {
    if (pendingAddedTaskId === null) return;
    const rowIndex = modelRows.findIndex((modelRow) => modelRow.original.id === pendingAddedTaskId);
    if (rowIndex === -1) return;
    setSelected({ rowIndex, colIndex: NAME_COL_INDEX });
    rowVirtualizer.scrollToIndex(rowIndex, { align: "auto" });
    setPendingAddedTaskId(null);
  }, [modelRows, pendingAddedTaskId, rowVirtualizer]);

  // Apply one or more commands as a single atomic edit. Multi-command batches
  // (e.g. a sibling reorder that swaps two rows' sortOrder) fold through the same
  // optimistic-apply → save → reload pipeline as a single edit: the whole batch
  // is applied locally first, then dispatched to the backend in order, chaining
  // each command onto the revision returned by the previous one.
  const executeCommands = useCallback(
    (commands: readonly ProjectCommand[]): boolean => {
      if (commands.length === 0) return false;
      if (saving.current) return false;
      const previousProject = project;
      const previousGrid = grid;
      let candidate: ProjectState = project;
      try {
        for (const command of commands) candidate = applyProjectCommand(candidate, command);
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "The edit could not be applied");
        return false;
      }
      // Optimistic recompute of the derived columns via the shared effort module.
      // In preview (no backend) the deterministic scheduler runs only for
      // `task.generateSubtasks`, placing just the newly-created leaf children as
      // initial values exactly as the server write path does (Design 0003 §C-2);
      // every other command applies with no rescheduling. With a backend the
      // reload after the command restores the server's daily plans.
      let optimistic = candidate;
      if (client === undefined && commands.some((command) => command.type === "task.generateSubtasks")) {
        const existingTaskIds = new Set(previousProject.tasks.map((task) => task.id));
        const newTaskIds = new Set(
          candidate.tasks.filter((task) => !existingTaskIds.has(task.id)).map((task) => task.id),
        );
        optimistic = applyEffortSchedule(candidate, newTaskIds);
      }
      // Preview has no backend, so every mutation is mirrored to localStorage
      // here (connected mode leaves storage untouched — the server is the
      // source of truth there).
      if (client === undefined) savePreviewProject(optimistic);
      setProject(optimistic);
      setGrid(projectWbsGrid(optimistic));
      setNotice(null);
      if (client !== undefined && revision !== null) {
        const backend = client;
        saving.current = true;
        setSaveState("saving");
        const dispatch = async (): Promise<string> => {
          let currentRevision = revision;
          for (const command of commands) {
            const result = await backend.execute(command, currentRevision);
            currentRevision = result.revision;
          }
          return currentRevision;
        };
        dispatch()
          .then(async (nextRevision) => {
            setRevision(nextRevision);
            setSaveState("saved");
            try {
              await reload();
            } catch {
              setNotice(`Saved at revision ${nextRevision}, but the grid could not be refreshed. Reload to retrieve derived values.`);
            }
          })
          .catch(async (error: unknown) => {
            if (error instanceof ProjectApiError && error.code === "VERSION_CONFLICT") {
              try {
                await reload();
                setNotice(`This project changed elsewhere and was reloaded at revision ${error.actualRevision ?? "latest"}. Your edit was not saved.`);
              } catch {
                setProject(previousProject);
                setGrid(previousGrid);
                setNotice("This project changed elsewhere, so your edit was not saved, and the latest revision could not be loaded.");
              }
            } else {
              setProject(previousProject);
              setGrid(previousGrid);
              setNotice(error instanceof Error ? error.message : "The edit could not be saved");
            }
            setSaveState("error");
          })
          .finally(() => { saving.current = false; });
      }
      return true;
    },
    [client, grid, project, reload, revision],
  );

  const executeCommand = useCallback(
    (command: ProjectCommand): boolean => executeCommands([command]),
    [executeCommands],
  );

  // Swap a row's sortOrder with an adjacent sibling's (same parentId), moving it
  // up or down within its sibling run without touching the parent hierarchy. The
  // two swapped values are read up front, so the batch is a true exchange; the
  // projection re-sorts by (sortOrder, id) and the two rows trade places, leaving
  // every other row's order untouched. Works identically in flat and tree modes.
  const reorderSibling = useCallback(
    (rowId: string, neighborId: string) => {
      if (!editable) return;
      const row = rows.find((candidate) => candidate.id === rowId);
      const neighbor = rows.find((candidate) => candidate.id === neighborId);
      if (row === undefined || neighbor === undefined) return;
      executeCommands([
        { type: "task.update", taskId: row.id, changes: { sortOrder: neighbor.sortOrder } },
        { type: "task.update", taskId: neighbor.id, changes: { sortOrder: row.sortOrder } },
      ]);
    },
    [editable, executeCommands, rows],
  );

  const generateSubtasks = useCallback(
    (parentTaskId: string) => {
      if (!editable || templateId === "") return;
      // Runs the same command the API accepts; the shared re-proration splits the
      // parent's effort across the template's weighted children, and the scheduler
      // auto-places each new leaf in dependency order (④).
      executeCommand({ type: "task.generateSubtasks", parentTaskId, templateId });
    },
    [editable, executeCommand, templateId],
  );

  const addTask = useCallback(
    (parentId: string | null) => {
      if (!editable) return;
      // New task lands as the last row overall (existing max sortOrder + 1) and
      // as a sibling of the current selection (same parentId), or at the root
      // when nothing is selected — never nested under it, since nesting is the
      // template generator's job.
      const sortOrder = rows.reduce((max, row) => Math.max(max, row.sortOrder), -1) + 1;
      const task: ProjectTask = {
        id: crypto.randomUUID(),
        parentId,
        sortOrder,
        name: "New task",
        process: "",
        product: "",
        note: "",
        contract: "",
        assigneeMemberId: null,
        plannedEffortMinutes: 0,
        progressBasisPoints: 0,
        actualEffortMinutes: 0,
        prorationWeightBp: null,
        dailyPlan: {},
        actualStart: null,
        actualFinish: null,
        dependencies: [],
      };
      if (executeCommand({ type: "task.add", task })) setPendingAddedTaskId(task.id);
    },
    [editable, executeCommand, rows],
  );

  // Preview-only: discard any locally-saved project and restore the scheduled
  // demo baseline, clearing selection/edit state so nothing points at a row
  // that no longer exists.
  const resetToDemo = useCallback(() => {
    clearPreviewProject();
    const demo = demoProjectScheduled();
    setProject(demo);
    setGrid(projectWbsGrid(demo));
    setSelected({ rowIndex: 0, colIndex: 0 });
    setEditing(null);
    setDailyEditing(null);
    setNotice(null);
  }, []);

  // 6px activation distance so a click (cell select / expand toggle) or a scroll
  // gesture never trips a drag, per the spike's PointerSensor tuning.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const onDragStart = useCallback((event: DragStartEvent) => {
    setActiveDrag((event.active.data.current as DragData | undefined) ?? null);
  }, []);

  const onDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveDrag(null);
      if (!editable) return;
      const active = event.active.data.current as DragData | undefined;
      const over = event.over?.data.current as DragData | undefined;
      if (active === undefined || over === undefined) return;
      const subtree = collectSubtree(active.id);
      const command = reparentCommand(active, over, (candidateId) => subtree.has(candidateId));
      if (command === null) return;
      // Re-parent through the same typed command as every other edit; ④'s
      // scheduler re-places the moved leaf and the leaf/rollup recompute on the
      // write path (old parent may become a leaf, the new parent a summary).
      const dispatched = executeCommand(command);
      // Reveal the moved subtree by expanding its new parent.
      if (dispatched && command.type === "task.update" && command.changes.parentId != null) {
        const newParentId = command.changes.parentId;
        setExpanded((previous) =>
          previous === true ? previous : { ...previous, [newParentId]: true },
        );
      }
    },
    [collectSubtree, editable, executeCommand],
  );

  const commit = useCallback(
    (column: MetaColumn, row: WbsGridTaskRow, raw: string) => {
      const changes = buildChanges(column, raw);
      if (changes === null) {
        setNotice(`"${raw}" is not a valid ${column.header} value`);
        return;
      }
      executeCommand({ type: "task.update", taskId: row.id, changes });
    },
    [executeCommand],
  );

  const beginDailyEdit = useCallback(
    (row: WbsGridTaskRow, date: string) => {
      // Every daily cell is hand-editable now (Design 0003 §C-2: no lock concept),
      // except a non-working day (shared weekend/holiday or the assignee's paid
      // leave), which never opens the editor — mirroring the cellEditable gate.
      if (!editable) return;
      if (sharedNonWorkingDates.has(date) || isPaidLeave(row.assigneeMemberId, date)) return;
      setDailyEditing({ rowId: row.id, date });
      const minutes = row.dailyPlan[date] ?? 0;
      setDailyEditValue(minutes > 0 ? formatNumber(minutes / 60) : "");
    },
    [editable, isPaidLeave, sharedNonWorkingDates],
  );

  const finishDailyEdit = useCallback(
    (persist: boolean) => {
      if (dailyEditing === null) return;
      if (persist) {
        const row = rows.find((candidate) => candidate.id === dailyEditing.rowId);
        if (row !== undefined) {
          const changes = buildDailyPlanChange(row, dailyEditing.date, dailyEditValue);
          if (changes === null) {
            setNotice(`"${dailyEditValue}" is not a valid plan-hours value`);
          } else {
            executeCommand({ type: "task.update", taskId: row.id, changes });
          }
        }
      }
      setDailyEditing(null);
    },
    [dailyEditValue, dailyEditing, executeCommand, rows],
  );

  const beginEdit = useCallback(
    (address: CellAddress) => {
      const column = META[address.colIndex];
      const row = modelRows[address.rowIndex]?.original;
      if (column === undefined || row === undefined || !column.editable || !editable) return;
      setSelected(address);
      setEditing(address);
      setEditValue(editInitialValue(column, row));
    },
    [editable, modelRows],
  );

  const finishEdit = useCallback(
    (persist: boolean) => {
      if (editing === null) return;
      const column = META[editing.colIndex];
      const row = modelRows[editing.rowIndex]?.original;
      if (persist && column !== undefined && row !== undefined) {
        commit(column, row, editValue);
      }
      setEditing(null);
    },
    [commit, editValue, editing, modelRows],
  );

  const moveSelection = useCallback(
    (rowDelta: number, colDelta: number) => {
      setSelected((current) => {
        const rowIndex = Math.max(0, Math.min(modelRows.length - 1, current.rowIndex + rowDelta));
        const colIndex = Math.max(0, Math.min(META.length - 1, current.colIndex + colDelta));
        if (rowDelta !== 0) rowVirtualizer.scrollToIndex(rowIndex, { align: "auto" });
        return { rowIndex, colIndex };
      });
    },
    [rowVirtualizer, modelRows.length],
  );

  const copySelection = useCallback(() => {
    const column = META[selected.colIndex];
    const row = modelRows[selected.rowIndex]?.original;
    if (column === undefined || row === undefined || navigator.clipboard === undefined) return;
    void navigator.clipboard
      .writeText(displayValue(column, row, selected.rowIndex))
      .catch(() => undefined);
  }, [modelRows, selected]);

  const pasteSelection = useCallback(() => {
    const column = META[selected.colIndex];
    const row = modelRows[selected.rowIndex]?.original;
    if (
      column === undefined ||
      row === undefined ||
      !column.editable ||
      !editable ||
      navigator.clipboard === undefined
    ) {
      return;
    }
    void navigator.clipboard
      .readText()
      .then((text) => commit(column, row, text.replace(/\r?\n$/u, "")))
      .catch(() => undefined);
  }, [commit, editable, modelRows, selected]);

  const onGridKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (editing !== null || dailyEditing !== null) return;
      if (event.key === "ArrowDown") { event.preventDefault(); moveSelection(1, 0); return; }
      if (event.key === "ArrowUp") { event.preventDefault(); moveSelection(-1, 0); return; }
      if (event.key === "ArrowRight") { event.preventDefault(); moveSelection(0, 1); return; }
      if (event.key === "ArrowLeft") { event.preventDefault(); moveSelection(0, -1); return; }
      if (event.key === "Enter" || event.key === "F2") { event.preventDefault(); beginEdit(selected); return; }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "c") { event.preventDefault(); copySelection(); return; }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "v") { event.preventDefault(); pasteSelection(); return; }
    },
    [beginEdit, copySelection, dailyEditing, editing, moveSelection, pasteSelection, selected],
  );

  const onEditorKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement | HTMLSelectElement>) => {
      if (event.key === "Enter") { event.preventDefault(); finishEdit(true); }
      else if (event.key === "Escape") { event.preventDefault(); finishEdit(false); }
    },
    [finishEdit],
  );

  const onDailyEditorKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") { event.preventDefault(); finishDailyEdit(true); }
      else if (event.key === "Escape") { event.preventDefault(); finishDailyEdit(false); }
    },
    [finishDailyEdit],
  );

  const renderMetaCell = (
    column: MetaColumn,
    colIndex: number,
    row: WbsGridTaskRow,
    rowIndex: number,
    tree?: NameCellTree,
  ) => {
    if (column.kind === "index") {
      const bounds = siblingBounds.get(row.id);
      const canMoveUp = editable && bounds?.prevId != null;
      const canMoveDown = editable && bounds?.nextId != null;
      const indexSelected = selected.rowIndex === rowIndex && selected.colIndex === colIndex;
      const warning = rowWarningById.get(row.id);
      const indexClasses = ["cell", "cell--index"];
      if (indexSelected) indexClasses.push("cell--selected");
      return (
        <div
          key={column.id}
          className={indexClasses.join(" ")}
          style={{ width: column.width }}
          role="gridcell"
          data-col={column.id}
          onMouseDown={() => setSelected({ rowIndex, colIndex })}
        >
          {warning !== undefined && (
            <span
              className="row-warning"
              data-testid="row-warning"
              data-task-id={row.id}
              role="img"
              aria-label={warning.title}
              title={warning.title}
            >
              ⚠
            </span>
          )}
          <span className="row-no">{rowIndex + 1}</span>
          <span className="reorder">
            <button
              type="button"
              className="reorder-button"
              data-testid="move-up"
              data-task-id={row.id}
              aria-label="ひとつ上の兄弟と入れ替え"
              title="上へ移動"
              disabled={!canMoveUp}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                if (bounds?.prevId != null) reorderSibling(row.id, bounds.prevId);
              }}
            >
              ▲
            </button>
            <button
              type="button"
              className="reorder-button"
              data-testid="move-down"
              data-task-id={row.id}
              aria-label="ひとつ下の兄弟と入れ替え"
              title="下へ移動"
              disabled={!canMoveDown}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                if (bounds?.nextId != null) reorderSibling(row.id, bounds.nextId);
              }}
            >
              ▼
            </button>
          </span>
        </div>
      );
    }
    const isSelected = selected.rowIndex === rowIndex && selected.colIndex === colIndex;
    const isEditing = editing?.rowIndex === rowIndex && editing.colIndex === colIndex;
    const classes = ["cell", `cell--${column.kind}`];
    if (column.editable) classes.push(editable ? "cell--editable" : "cell--locked");
    if (isSelected) classes.push("cell--selected");
    if (column.kind === "status") classes.push(`status--${row.status.toLowerCase()}`);
    if (column.kind === "derivedNum" && column.id === "costVarianceHours" && row.costVarianceHours < 0) {
      classes.push("cell--negative");
    }
    const style: CSSProperties =
      column.id === "process"
        ? { width: column.width, borderLeft: `3px solid hsl(${processHue(row.process)} 50% 55%)` }
        : { width: column.width };
    return (
      <div
        key={column.id}
        className={classes.join(" ")}
        style={style}
        role="gridcell"
        data-col={column.id}
        onMouseDown={() => setSelected({ rowIndex, colIndex })}
        onDoubleClick={() => beginEdit({ rowIndex, colIndex })}
      >
        {tree !== undefined && (
          <span className="tree-affordance" style={{ paddingLeft: tree.depth * 16 }}>
            {tree.canExpand ? (
              <button
                type="button"
                className="tree-toggle"
                data-testid="tree-toggle"
                data-task-id={row.id}
                aria-label={tree.isExpanded ? "Collapse" : "Expand"}
                aria-expanded={tree.isExpanded}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  tree.onToggleExpand();
                }}
              >
                {tree.isExpanded ? "▾" : "▸"}
              </button>
            ) : (
              <span className="tree-toggle-spacer" aria-hidden />
            )}
            <span
              ref={tree.dragRef}
              className="drag-grip"
              data-testid="drag-grip"
              data-task-id={row.id}
              title="ドラッグで親を付け替え"
              {...(tree.dragListeners ?? {})}
              {...(tree.dragAttributes ?? {})}
            >
              ⠿
            </span>
          </span>
        )}
        {isEditing
          ? column.kind === "assignee"
            ? (
              <select
                className="cell-editor"
                autoFocus
                value={editValue}
                onChange={(event) => setEditValue(event.target.value)}
                onBlur={() => finishEdit(true)}
                onKeyDown={onEditorKeyDown}
              >
                <option value="">— 未割り当て —</option>
                {memberOptions.map((member) => (
                  <option key={member.id} value={member.id}>{member.name}</option>
                ))}
              </select>
            )
            : (
              <input
                className="cell-editor"
                autoFocus
                value={editValue}
                onChange={(event) => setEditValue(event.target.value)}
                onBlur={() => finishEdit(true)}
                onKeyDown={onEditorKeyDown}
              />
            )
          : <span className="cell-text">{displayValue(column, row, rowIndex)}</span>}
      </div>
    );
  };

  const rollup = grid.rollup;
  const selectedRow = modelRows[selected.rowIndex]?.original;

  // Month band over the day columns: group the currently-visible virtualized days
  // into contiguous YYYY-MM runs. Each band's left is its first day's virtual
  // start and its width spans to the last day's right edge. Derived from the
  // visible virtual items every render, so it re-lays-out as the day columns
  // scroll horizontally.
  const monthBands: { key: string; month: string; left: number; width: number }[] = [];
  for (const item of dayVirtualizer.getVirtualItems()) {
    const month = days[item.index]!.slice(0, 7);
    const right = item.start + DAILY_COL_W;
    const previous = monthBands[monthBands.length - 1];
    if (previous !== undefined && previous.month === month) {
      previous.width = right - previous.left;
    } else {
      monthBands.push({ key: `${month}-${item.index}`, month, left: item.start, width: DAILY_COL_W });
    }
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <h1>VECTA</h1>
          <p className="app-subtitle">
            {project.name ? `${project.name} · ` : ""}基準日 {grid.statusDate} · {rows.length.toLocaleString()} タスク · {planDays.length} 計画日
          </p>
        </div>
        <div className={`save-badge save-badge--${saveState}`} data-testid="save-state">{saveState}</div>
      </header>

      <section className="rollup" aria-label="プロジェクト集計" data-testid="rollup">
        <RollupMetric label="BAC (人日)" value={formatNumber(rollup.bac)} />
        <RollupMetric label="PV (人日)" value={formatNumber(rollup.pv)} />
        <RollupMetric label="EV (人日)" value={formatNumber(rollup.ev)} />
        <RollupMetric label="AC (人日)" value={formatNumber(rollup.ac)} />
        <RollupMetric label="SV (人日)" value={formatNumber(rollup.sv)} tone={rollup.sv < 0 ? "risk" : "ok"} />
        <RollupMetric label="CV (人日)" value={formatNumber(rollup.cv)} tone={rollup.cv < 0 ? "risk" : "ok"} />
        <RollupMetric label="SPI" value={rollup.spi === "-" ? "—" : rollup.spi.toFixed(2)} />
        <RollupMetric label="CPI" value={rollup.cpi === "-" ? "—" : rollup.cpi.toFixed(2)} />
      </section>

      <section className="toolbar" aria-label="表示切り替え" data-testid="view-toolbar">
        <div className="view-toggle" role="group" aria-label="行レイアウト" data-testid="view-toggle">
          <button
            type="button"
            className={`view-toggle-button ${treeMode ? "" : "view-toggle-button--active"}`}
            data-testid="view-mode-flat"
            aria-pressed={!treeMode}
            onClick={() => setViewMode("flat")}
          >
            フラット
          </button>
          <button
            type="button"
            className={`view-toggle-button ${treeMode ? "view-toggle-button--active" : ""}`}
            data-testid="view-mode-tree"
            aria-pressed={treeMode}
            onClick={() => setViewMode("tree")}
          >
            ツリー
          </button>
        </div>
        <span className="toolbar-hint">No. 列の ▲ ▼ で同じ親の兄弟どうしを並べ替え</span>
        {treeMode && (
          <>
            <button
              type="button"
              className="toolbar-button toolbar-button--ghost"
              data-testid="expand-all"
              onClick={() => table.toggleAllRowsExpanded(true)}
            >
              すべて展開
            </button>
            <button
              type="button"
              className="toolbar-button toolbar-button--ghost"
              data-testid="collapse-all"
              onClick={() => table.toggleAllRowsExpanded(false)}
            >
              すべて折りたたむ
            </button>
            <span className="toolbar-hint">行の ⠿ ハンドルを別のタスクにドラッグすると親を付け替え</span>
          </>
        )}
      </section>

      <section className="toolbar" aria-label="サブタスク生成" data-testid="subtask-toolbar">
        <button
          type="button"
          className="toolbar-button"
          data-testid="add-task"
          disabled={!editable}
          onClick={() => addTask(selectedRow?.parentId ?? null)}
        >
          タスク追加
        </button>
        {client === undefined && (
          <button
            type="button"
            className="toolbar-button toolbar-button--ghost"
            data-testid="reset-to-demo"
            onClick={resetToDemo}
          >
            デモに戻す
          </button>
        )}
        <label className="toolbar-field">
          <span className="toolbar-label">テンプレート</span>
          <select
            className="toolbar-select"
            data-testid="template-select"
            value={templateId}
            disabled={!editable}
            onChange={(event) => setTemplateId(event.target.value)}
          >
            {SUBTASK_TEMPLATES.map((template) => (
              <option key={template.id} value={template.id}>{template.name}</option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="toolbar-button"
          data-testid="generate-subtasks"
          data-selected-task-id={selectedRow?.id ?? ""}
          disabled={!editable || selectedRow === undefined}
          onClick={() => selectedRow !== undefined && generateSubtasks(selectedRow.id)}
        >
          サブタスク生成
        </button>
        <span className="toolbar-hint">
          {selectedRow === undefined
            ? "生成先となるタスク行を選択してください"
            : `親の工数をテンプレートに沿って「${selectedRow.name}」へ按分します`}
        </span>
      </section>

      <section className="toolbar" aria-label="他プロジェクト負荷" data-testid="load-toolbar">
        <button
          type="button"
          className={`toolbar-button toolbar-button--ghost ${showExternalLoad ? "toolbar-button--on" : ""}`}
          data-testid="toggle-external-load"
          aria-pressed={showExternalLoad}
          onClick={() => setShowExternalLoad((on) => !on)}
        >
          {showExternalLoad ? "他PJ負荷: 表示" : "他PJ負荷: 非表示"}
        </button>
        {showExternalLoad &&
          (overloadSummary === null ? (
            <span
              className="load-summary load-summary--ok"
              data-testid="overload-summary"
              data-overload-count={0}
            >
              工数超過なし
            </span>
          ) : (
            <span
              className="load-summary load-summary--risk"
              data-testid="overload-summary"
              data-overload-count={overloadSummary.count}
              title={overloadSummary.title}
            >
              ⚠ {overloadSummary.count.toLocaleString()} 件の工数超過
            </span>
          ))}
        <span className="toolbar-hint">
          半透明の帯は担当者が他PJで埋まっている時間。赤いセルはその日の合計工数がキャパ超過。
        </span>
      </section>

      {notice !== null && <div className="notice" role="alert">{notice}</div>}

      {/* DndContext stays mounted in both modes so the scroller never remounts on
          the flat⇄tree toggle (spike gotcha #2); the per-row hooks are simply
          disabled in flat mode. */}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragCancel={() => setActiveDrag(null)}
      >
      <div
        ref={scrollerRef}
        className="scroller"
        role="grid"
        tabIndex={0}
        aria-rowcount={rows.length}
        data-testid="wbs-grid"
        onKeyDown={onGridKeyDown}
      >
        <div
          className="grid-canvas"
          style={{ height: rowVirtualizer.getTotalSize(), width: dayVirtualizer.getTotalSize() }}
        >
          <div className="grid-header" style={{ width: dayVirtualizer.getTotalSize(), height: HEADER_H }}>
            {/* Top band row: grouped EVM headers over the meta columns. Only banded
                non-pinned columns get a band; every other column's band area stays
                blank. Bands scroll horizontally with the meta columns they cover. */}
            {BANDS.map((band) => (
              <div
                key={band.id}
                className={`head-band head-band--${band.id}`}
                style={{ left: band.left, width: band.width, height: BAND_H }}
                title={band.label}
              >
                <span className="head-band-label">{band.label}</span>
              </div>
            ))}
            {/* Name row: the pinned group stays full-height (opaque, sticky-left) so
                it covers band/name cells scrolling underneath, with its labels
                bottom-aligned into the name row below the band strip. */}
            <div className="pinned-group pinned-group--header" style={{ width: PINNED_WIDTH }}>
              {PINNED.map((column) => (
                <div key={column.id} className="head-cell" style={{ width: column.width, height: HEAD_NAME_H }} title={column.header}>
                  <span className="head-label">{column.header}</span>
                </div>
              ))}
            </div>
            {NON_PINNED.map((column, index) => (
              <div
                key={column.id}
                className={`head-cell head-cell--abs${column.band !== undefined ? ` head-cell--band-${column.band}` : ""}`}
                style={{ left: NON_PINNED_LEFT[index], width: column.width, top: BAND_H, height: HEAD_NAME_H }}
                title={column.header}
              >
                <span className="head-label">{column.header}</span>
              </div>
            ))}
            {/* Top row: one neutral band per distinct month among the visible days,
                aligned with the META header's band row. */}
            {monthBands.map((band) => (
              <div
                key={band.key}
                className="head-band head-month"
                style={{ left: band.left, width: band.width, height: BAND_H }}
                title={band.month}
              >
                <span className="head-band-label">{band.month}</span>
              </div>
            ))}
            {/* Bottom row: the day-of-month, greyed on shared weekend/holiday
                columns so the header reads like the body below it. */}
            {dayVirtualizer.getVirtualItems().map((virtualDay) => {
              const date = days[virtualDay.index]!;
              const nonWorking = sharedNonWorkingDates.has(date);
              return (
                <div
                  key={virtualDay.key}
                  className={`head-cell head-cell--day${nonWorking ? " head-cell--nonworking" : ""}`}
                  style={{ left: virtualDay.start, width: DAILY_COL_W, top: BAND_H, height: HEAD_NAME_H }}
                  title={date}
                >
                  {date.slice(8)}
                </div>
              );
            })}
          </div>

          {rowVirtualizer.getVirtualItems().map((virtualRow) => {
            const modelRow = modelRows[virtualRow.index]!;
            const row = modelRow.original;
            const rowIndex = virtualRow.index;
            const depth = modelRow.depth;
            const canExpand = modelRow.getCanExpand();
            const isExpanded = modelRow.getIsExpanded();
            const toggleExpand = modelRow.getToggleExpandedHandler();
            return (
              <DndRow
                key={virtualRow.key}
                id={row.id}
                parentId={row.parentId}
                name={row.name}
                enabled={treeMode}
              >
                {(dnd) => (
              <div
                ref={dnd.dropRef}
                className={`grid-row ${row.parentId === null ? "grid-row--parent" : "grid-row--child"}${rowWarningById.has(row.id) ? " grid-row--warning" : ""}${dnd.isOver ? " grid-row--drop-target" : ""}`}
                role="row"
                data-warning={rowWarningById.has(row.id) ? "true" : undefined}
                data-row-id={row.id}
                data-depth={depth}
                style={{ top: virtualRow.start, height: ROW_H, width: dayVirtualizer.getTotalSize() }}
              >
                <div className="pinned-group" style={{ width: PINNED_WIDTH }}>
                  {PINNED.map((column) =>
                    renderMetaCell(
                      column,
                      META.indexOf(column),
                      row,
                      rowIndex,
                      treeMode && column.id === "name"
                        ? {
                            depth,
                            canExpand,
                            isExpanded,
                            onToggleExpand: toggleExpand,
                            dragRef: dnd.dragRef,
                            dragListeners: dnd.dragListeners,
                            dragAttributes: dnd.dragAttributes,
                          }
                        : undefined,
                    ),
                  )}
                </div>
                {NON_PINNED.map((column, index) => (
                  <div
                    key={column.id}
                    className="cell-slot"
                    style={{ left: NON_PINNED_LEFT[index], width: column.width }}
                  >
                    {renderMetaCell(column, META.indexOf(column), row, rowIndex)}
                  </div>
                ))}
                {dayVirtualizer.getVirtualItems().map((virtualDay) => {
                  const date = days[virtualDay.index]!;
                  const minutes = row.dailyPlan[date] ?? 0;
                  // Shared weekend/holiday (grey) takes precedence over the
                  // assignee's paid leave (violet); either blocks editing. Every
                  // working day is hand-editable now (Design 0003 §C-2: no lock).
                  const nonWorking = sharedNonWorkingDates.has(date);
                  const paidLeave = !nonWorking && isPaidLeave(row.assigneeMemberId, date);
                  const cellEditable = editable && !nonWorking && !paidLeave;
                  const isEditing =
                    dailyEditing?.rowId === row.id && dailyEditing.date === date;
                  // Cross-project overlay + overflow, per the row's assignee.
                  const assignee = row.assigneeMemberId;
                  const externalMinutes =
                    showExternalLoad && assignee !== null
                      ? externalMinutesFor(externalLoad, assignee, date)
                      : 0;
                  const capacity = assignee !== null ? capacityByMember.get(assignee) : undefined;
                  const loadFraction =
                    externalMinutes > 0 && capacity !== undefined
                      ? Math.min(1, externalMinutes / capacity)
                      : 0;
                  const overloadEntry =
                    showExternalLoad && assignee !== null
                      ? overloadByKey.get(overloadKey(assignee, date))
                      : undefined;
                  const classes = ["daily-cell"];
                  if (minutes > 0) classes.push("daily-cell--filled");
                  if (nonWorking) classes.push("daily-cell--nonworking");
                  else if (paidLeave) classes.push("daily-cell--leave");
                  classes.push(cellEditable ? "daily-cell--editable" : "daily-cell--readonly");
                  if (overloadEntry !== undefined) classes.push("daily-cell--overload");
                  return (
                    <div
                      key={virtualDay.key}
                      className={classes.join(" ")}
                      style={{ left: virtualDay.start, width: DAILY_COL_W }}
                      data-daily-row={row.id}
                      data-daily-date={date}
                      data-overload={overloadEntry !== undefined ? "true" : undefined}
                      aria-readonly={cellEditable ? undefined : true}
                      title={
                        overloadEntry !== undefined
                          ? `⚠ 工数超過 ${date.slice(5)}: 合計 ${formatNumber(overloadEntry.totalMinutes / 60)}h（本PJ ${formatNumber(overloadEntry.projectMinutes / 60)}h + 他PJ ${formatNumber(overloadEntry.externalMinutes / 60)}h）＞ 上限 ${formatNumber(overloadEntry.capacityMinutes / 60)}h`
                          : externalMinutes > 0
                            ? `他PJ負荷 ${formatNumber(externalMinutes / 60)}h`
                            : cellEditable
                              ? "日別計画 — ダブルクリックで編集"
                              : "日別計画（非稼働日）"
                      }
                      onDoubleClick={() => beginDailyEdit(row, date)}
                    >
                      {loadFraction > 0 && (
                        <div
                          className={`daily-load-overlay${overloadEntry !== undefined ? " daily-load-overlay--overload" : ""}`}
                          style={{ height: `${Math.round(loadFraction * 100)}%` }}
                          data-testid="daily-load-overlay"
                          aria-hidden
                        />
                      )}
                      <span className="daily-cell-value">
                        {isEditing ? (
                          <input
                            className="cell-editor daily-cell-editor"
                            autoFocus
                            value={dailyEditValue}
                            onChange={(event) => setDailyEditValue(event.target.value)}
                            onBlur={() => finishDailyEdit(true)}
                            onKeyDown={onDailyEditorKeyDown}
                          />
                        ) : minutes > 0 ? (
                          formatNumber(minutes / 60)
                        ) : (
                          ""
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
                )}
              </DndRow>
            );
          })}
        </div>
      </div>
      <DragOverlay dropAnimation={null}>
        {activeDrag !== null ? (
          <div className="drag-overlay-chip" data-testid="drag-overlay">
            {activeDrag.name}
          </div>
        ) : null}
      </DragOverlay>
      </DndContext>
    </div>
  );
}

// One label→value pair in the compact totals strip (a dense spreadsheet-style
// summary row, not a KPI card). `risk` tone reddens a negative SV/CV value.
function RollupMetric({ label, value, tone }: { readonly label: string; readonly value: string; readonly tone?: "ok" | "risk" }) {
  return (
    <div className={`rollup-metric ${tone === "risk" ? "rollup-metric--risk" : ""}`}>
      <span className="rollup-metric-label">{label}</span>
      <span className="rollup-metric-value">{value}</span>
    </div>
  );
}
