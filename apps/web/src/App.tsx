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
  | "process"
  | "product"
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
  { id: "process", header: "工程", width: 104, pinned: true, editable: true, kind: "process", field: "processId" },
  { id: "name", header: "タスク・サブタスク", width: 240, pinned: true, editable: true, kind: "text", field: "name" },
  { id: "assignee", header: "担当", width: 120, pinned: true, editable: true, kind: "assignee", field: "assigneeMemberId" },
  { id: "product", header: "プロダクト", width: 108, pinned: false, editable: true, kind: "product", field: "productId" },
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
// Column the selection lands on after a draft commit, so the freshly-created
// task row is ready for an immediate inline-edit of its name.
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

/**
 * A grid row augmented with `subRows` for TanStack's expanded row model: the flat
 * projection rows are nested under their `parentId`. The tree is the only view
 * mode now (Design 0003 §C-1). The tree engine (TanStack Table
 * `getExpandedRowModel`) is the same one validated in the grid spike
 * (FINDINGS §"ツリー階層").
 */
type TreeRow = WbsGridTaskRow & { readonly subRows?: readonly TreeRow[] };

/** A pending, uncommitted subtask row a person opened under a parent (§C-5). */
interface SubtaskDraft {
  readonly id: string;
  readonly parentId: string;
}

/**
 * One rendered grid line. Real projection rows (`task`) and empty draft rows
 * (`draft`, §C-4/§C-5) share one virtualized sequence so selection, keyboard
 * nav, and the virtualizer all address a single index space. A `tail` draft is
 * one of the empty append rows at the end of the grid; a `subtask` draft is an
 * empty child opened under a specific parent through the row menu.
 */
interface TaskRenderRow {
  readonly kind: "task";
  readonly key: string;
  readonly row: WbsGridTaskRow;
  readonly depth: number;
  readonly canExpand: boolean;
  readonly isExpanded: boolean;
  readonly onToggleExpand: () => void;
}
interface DraftRenderRow {
  readonly kind: "draft";
  readonly key: string;
  readonly parentId: string | null;
  readonly depth: number;
  readonly source: "tail" | "subtask";
  readonly subtaskDraftId?: string;
}
type RenderRow = TaskRenderRow | DraftRenderRow;

/** The open row action menu (§C-5): its target task and screen position. */
interface RowMenuState {
  readonly taskId: string;
  readonly x: number;
  readonly y: number;
  readonly showTemplates: boolean;
}

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
}

/**
 * The dnd-kit drag handle for a row, hosted in the leftmost (No.) column so the
 * ⠿ grip reads as the row's left-edge affordance (Design 0003 §C-3).
 */
interface DragHandle {
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
 * The `task.update` sortOrder commands a reorder drop should dispatch, or `[]`
 * when the drop moves nothing (Design 0003 §C-3: drag reorders, never
 * re-parents). A row reorders only within its own sibling group (same
 * `parentId`): dropping A onto B in a different group — or onto itself — is a
 * no-op, so a subtask can never leave its parent and a root can only re-order
 * among roots (its whole subtree rides along, since the subtree nests by
 * `parentId`). This same-scope rule also subsumes the acyclic guard — a parent's
 * descendants never share its `parentId`, so it can never drop into its own
 * subtree.
 *
 * Within the group, A is spliced to B's slot — after B when A sat before B,
 * before B when A sat after B (moving toward B's slot) — and the group's own
 * sortOrder values are reassigned in the new order. Only the reordered slice
 * renumbers; every other row (and every other sibling group) keeps its value,
 * so the tree's sibling order changes exactly where intended. `rows` must be the
 * projection order (sorted by (sortOrder, id)), which is the render order.
 */
export function reorderSiblingCommands(
  active: DragData,
  over: DragData,
  rows: readonly WbsGridTaskRow[],
): ProjectCommand[] {
  if (over.id === active.id) return [];
  if (over.parentId !== active.parentId) return [];
  const group = rows.filter((row) => row.parentId === active.parentId);
  const orderedIds = group.map((row) => row.id);
  const activeIndex = orderedIds.indexOf(active.id);
  const overIndex = orderedIds.indexOf(over.id);
  if (activeIndex === -1 || overIndex === -1) return [];
  const nextOrder = orderedIds.filter((id) => id !== active.id);
  // Splicing at `overIndex` lands A after B when it moved down (B shifts left one
  // slot after A's removal) and before B when it moved up (B keeps its index).
  nextOrder.splice(overIndex, 0, active.id);
  const values = group.map((row) => row.sortOrder);
  const currentById = new Map(group.map((row) => [row.id, row.sortOrder]));
  const commands: ProjectCommand[] = [];
  nextOrder.forEach((id, index) => {
    const value = values[index]!;
    if (currentById.get(id) !== value) {
      commands.push({ type: "task.update", taskId: id, changes: { sortOrder: value } });
    }
  });
  return commands;
}

/**
 * Per-row dnd wrapper. It calls the draggable/droppable hooks once per rendered
 * task row (rules of hooks) and hands their refs/listeners to a render prop, so
 * the heavy row markup stays inline in `App` with direct access to grid state.
 * The tree is the only view mode, so the per-row hooks are always enabled; only
 * real task rows are wrapped (draft rows are never draggable/droppable).
 */
function DndRow({
  id,
  parentId,
  name,
  children,
}: {
  readonly id: string;
  readonly parentId: string | null;
  readonly name: string;
  readonly children: (bag: {
    readonly dropRef?: ((element: HTMLElement | null) => void) | undefined;
    readonly dragRef?: ((element: HTMLElement | null) => void) | undefined;
    readonly dragListeners?: DragListeners | undefined;
    readonly dragAttributes?: DragAttributes | undefined;
    readonly isOver: boolean;
  }) => ReactNode;
}): ReactNode {
  const data: DragData = { id, parentId, name };
  const draggable = useDraggable({ id: `drag-${id}`, data });
  const droppable = useDroppable({ id: `drop-${id}`, data });
  return children({
    dropRef: droppable.setNodeRef,
    dragRef: draggable.setNodeRef,
    dragListeners: draggable.listeners,
    dragAttributes: draggable.attributes,
    isOver: droppable.isOver,
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
    case "process":
      return row.processName;
    case "product":
      return row.productName;
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
    case "process":
      return row.processId ?? "";
    case "product":
      return row.productId ?? "";
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
      return { processId: trimmed === "" ? null : trimmed };
    case "product":
      return { productId: trimmed === "" ? null : trimmed };
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
  processes: [],
  products: [],
  templates: [],
  tasks: [],
};

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
    // Preview (dev/demo only, Design 0003 §A-1): start from a fresh scheduled demo
    // baseline every mount. Edits are ephemeral — there is no localStorage mirror,
    // so a reload restores the demo rather than reviving prior preview edits.
    return demoProjectScheduled();
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
  // §C-4 — empty draft rows at the tail of the grid. `draftCount` empty rows
  // render after every real row; committing a field on one turns it into a real
  // root task and consumes it (min one draft always remains). `addRowsCount` is
  // the "+ 行追加" stepper's n (1–1000).
  const [draftCount, setDraftCount] = useState(1);
  const [addRowsCount, setAddRowsCount] = useState(1);
  // §C-5 — empty child draft rows a person opened under a parent through the row
  // menu. Committing one dispatches task.add with that parentId and consumes it.
  const [subtaskDrafts, setSubtaskDrafts] = useState<readonly SubtaskDraft[]>([]);
  // §C-5 — the open row action menu (⋯ / right-click), or null when closed.
  const [rowMenu, setRowMenu] = useState<RowMenuState | null>(null);
  // Expanded state. Default `true` = every parent expanded (the spike's initial
  // all-expanded worst case), independent of async load timing; a per-row
  // collapse narrows it to a record.
  const [expanded, setExpanded] = useState<ExpandedState>(true);
  const [activeDrag, setActiveDrag] = useState<DragData | null>(null);
  // Id of a just-added task awaiting its first appearance in the rendered rows,
  // so it can be selected (and scrolled to) once the grid re-renders with it.
  const [pendingAddedTaskId, setPendingAddedTaskId] = useState<string | null>(null);
  const saving = useRef(false);
  const scrollerRef = useRef<HTMLDivElement>(null);

  const rows = grid.rows as WbsGridTaskRow[];
  const editable = saveState === "preview" || saveState === "saved";

  const memberOptions = useMemo(
    () => project.members.map((member) => ({ id: member.id, name: member.name })),
    [project.members],
  );
  // 工程 / プロダクト dropdown options (Design 0003 §C-6), ordered by the master's
  // sortOrder so the grid select mirrors the master screen's ordering.
  const processOptions = useMemo(
    () =>
      [...project.processes]
        .sort((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id))
        .map((process) => ({ id: process.id, name: process.name })),
    [project.processes],
  );
  const productOptions = useMemo(
    () =>
      [...project.products]
        .sort((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id))
        .map((product) => ({ id: product.id, name: product.name })),
    [project.products],
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
  // daily commitment behind the seam (swapped for a real read in Phase 2).
  // `overloads` are the (member, date) pairs whose this-project + other-project
  // total exceeds the member's daily capacity, keyed for O(1) day-cell lookup.
  // The overlay + overload signal is always on now (Design 0003 §D-1: the toggle
  // is gone); it stays a quiet, half-transparent context behind the day cells.
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
    () => detectOverloads({ rows, external: externalLoad, members: project.members }),
    [rows, externalLoad, project.members],
  );
  const overloadByKey = useMemo(() => {
    const map = new Map<string, OverloadEntry>();
    for (const entry of overloads) map.set(overloadKey(entry.memberId, entry.date), entry);
    return map;
  }, [overloads]);

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

  // The grid is always the tree (Design 0003 §C-1): projection rows nested under
  // their parentId. There is no flat mode anymore.
  const treeData = useMemo(() => buildTree(rows), [rows]);
  const data: TreeRow[] = treeData;

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
  // The expanded/visible set (collapsed subtrees drop out), so the row
  // virtualizer window shrinks with collapse.
  const modelRows = table.getRowModel().rows;

  // The single rendered sequence of real rows + draft rows. Subtask drafts (§C-5)
  // are inserted at the end of their parent's visible subtree so a committed
  // child (sortOrder = max+1 ⇒ last sibling) lands where its draft sat; the tail
  // root drafts (§C-4) follow every real row. Selection, keyboard nav, and the
  // row virtualizer all address this one index space.
  const renderRows = useMemo<RenderRow[]>(() => {
    const result: RenderRow[] = [];
    const draftsByParent = new Map<string, SubtaskDraft[]>();
    for (const draft of subtaskDrafts) {
      const group = draftsByParent.get(draft.parentId) ?? [];
      group.push(draft);
      draftsByParent.set(draft.parentId, group);
    }
    // subtreeEnd[i] = last modelRows index in row i's subtree (inclusive); a leaf
    // ends at itself. Built once in O(n) so draft insertion is a Map lookup.
    const count = modelRows.length;
    const subtreeEnd = new Array<number>(count);
    for (let i = count - 1; i >= 0; i -= 1) {
      let end = i;
      let j = i + 1;
      while (j < count && modelRows[j]!.depth > modelRows[i]!.depth) {
        end = subtreeEnd[j]!;
        j = subtreeEnd[j]! + 1;
      }
      subtreeEnd[i] = end;
    }
    const closesAt = new Map<number, number[]>();
    for (let p = 0; p < count; p += 1) {
      const end = subtreeEnd[p]!;
      const list = closesAt.get(end) ?? [];
      list.push(p);
      closesAt.set(end, list);
    }
    for (let i = 0; i < count; i += 1) {
      const modelRow = modelRows[i]!;
      result.push({
        kind: "task",
        key: `task-${modelRow.original.id}`,
        row: modelRow.original,
        depth: modelRow.depth,
        canExpand: modelRow.getCanExpand(),
        isExpanded: modelRow.getIsExpanded(),
        onToggleExpand: modelRow.getToggleExpandedHandler(),
      });
      // Deepest-ending subtree first, so each parent's drafts nest just below it.
      const closing = (closesAt.get(i) ?? []).slice().sort((a, b) => modelRows[b]!.depth - modelRows[a]!.depth);
      for (const p of closing) {
        const parentRow = modelRows[p]!;
        const drafts = draftsByParent.get(parentRow.original.id);
        if (drafts === undefined) continue;
        for (const draft of drafts) {
          result.push({
            kind: "draft",
            key: `subtask-draft-${draft.id}`,
            parentId: draft.parentId,
            depth: parentRow.depth + 1,
            source: "subtask",
            subtaskDraftId: draft.id,
          });
        }
      }
    }
    for (let n = 0; n < draftCount; n += 1) {
      result.push({ kind: "draft", key: `tail-draft-${n}`, parentId: null, depth: 0, source: "tail" });
    }
    return result;
  }, [modelRows, subtaskDrafts, draftCount]);

  const taskRowAt = useCallback(
    (rowIndex: number): WbsGridTaskRow | undefined => {
      const renderRow = renderRows[rowIndex];
      return renderRow !== undefined && renderRow.kind === "task" ? renderRow.row : undefined;
    },
    [renderRows],
  );

  // parentId → child ids and id → row, for the collapsed-parent rollup below.
  // Built from the full projection, not the visible set, so a collapsed parent
  // still aggregates its hidden descendants.
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
  const rowById = useMemo(() => {
    const map = new Map<string, WbsGridTaskRow>();
    for (const row of rows) map.set(row.id, row);
    return map;
  }, [rows]);

  // Design 0003 §C-7 — the display-only rollup a parent row shows *while
  // collapsed*: its subtree's total effort (Σ of descendant leaves'
  // plannedEffortMinutes) and, per date, the Σ of that day across all
  // descendants' dailyPlan. Aggregated bottom-up over the tree (a leaf
  // contributes its own effort/plan; a parent sums its children), memoized per
  // id. This never touches the leaf-only EVM math or the projection — the grid
  // just reads it for a collapsed parent's effort/daily cells.
  const subtreeRollupById = useMemo(() => {
    const map = new Map<string, { effortMinutes: number; daily: Map<string, number> }>();
    const compute = (id: string): { effortMinutes: number; daily: Map<string, number> } => {
      const cached = map.get(id);
      if (cached !== undefined) return cached;
      const acc = { effortMinutes: 0, daily: new Map<string, number>() };
      const children = childrenByParentId.get(id);
      if (children === undefined || children.length === 0) {
        const row = rowById.get(id);
        if (row !== undefined) {
          acc.effortMinutes = row.plannedEffortMinutes;
          for (const [date, minutes] of Object.entries(row.dailyPlan)) acc.daily.set(date, minutes);
        }
      } else {
        for (const childId of children) {
          const childAcc = compute(childId);
          acc.effortMinutes += childAcc.effortMinutes;
          for (const [date, minutes] of childAcc.daily) {
            acc.daily.set(date, (acc.daily.get(date) ?? 0) + minutes);
          }
        }
      }
      map.set(id, acc);
      return acc;
    };
    for (const row of rows) compute(row.id);
    return map;
  }, [rows, rowById, childrenByParentId]);

  // initialRect seeds the viewport before the browser measures the scroller on
  // the first frame; a no-layout environment (e.g. tests) falls back to it.
  const rowVirtualizer = useVirtualizer({
    count: renderRows.length,
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
    const rowIndex = renderRows.findIndex(
      (renderRow) => renderRow.kind === "task" && renderRow.row.id === pendingAddedTaskId,
    );
    if (rowIndex === -1) return;
    setSelected({ rowIndex, colIndex: NAME_COL_INDEX });
    rowVirtualizer.scrollToIndex(rowIndex, { align: "auto" });
    setPendingAddedTaskId(null);
  }, [renderRows, pendingAddedTaskId, rowVirtualizer]);

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
      // Preview edits are in-memory only (Design 0003 §A-1: no localStorage
      // mirror); connected mode leaves storage untouched — the server is the
      // source of truth there.
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

  // §C-5 — generate subtasks from a template chosen in the row menu. Runs the same
  // command the API accepts; the shared re-proration splits the parent's effort
  // across the template's weighted children, and the scheduler auto-places each
  // new leaf once as an initial value (④), then closes the menu.
  const generateSubtasks = useCallback(
    (parentTaskId: string, templateId: string) => {
      if (!editable || templateId === "") return;
      executeCommand({ type: "task.generateSubtasks", parentTaskId, templateId });
      setRowMenu(null);
    },
    [editable, executeCommand],
  );

  // §C-4/§C-5 — commit a field typed into a draft row, turning it into a real
  // task. The new task lands as the last row overall (existing max sortOrder + 1)
  // under the draft's parent (null for a tail draft ⇒ a root task; a parent id
  // for a subtask draft ⇒ that parent's child). An empty commit creates nothing,
  // spreadsheet-style. Committing consumes the draft: a tail draft decrements the
  // tail count (min one always remains); a subtask draft is dropped from the list.
  const commitDraft = useCallback(
    (column: MetaColumn, draft: DraftRenderRow, raw: string) => {
      if (!editable) return;
      if (raw.trim() === "") return;
      const changes = buildChanges(column, raw);
      if (changes === null) {
        setNotice(`"${raw}" is not a valid ${column.header} value`);
        return;
      }
      const sortOrder = rows.reduce((max, row) => Math.max(max, row.sortOrder), -1) + 1;
      const task: ProjectTask = {
        id: crypto.randomUUID(),
        parentId: draft.parentId,
        sortOrder,
        name: "",
        processId: null,
        productId: null,
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
        ...changes,
      };
      if (executeCommand({ type: "task.add", task })) {
        setPendingAddedTaskId(task.id);
        if (draft.source === "tail") setDraftCount((n) => Math.max(1, n - 1));
        else if (draft.subtaskDraftId !== undefined) {
          const consumed = draft.subtaskDraftId;
          setSubtaskDrafts((list) => list.filter((entry) => entry.id !== consumed));
        }
      }
    },
    [editable, executeCommand, rows],
  );

  // §C-5 — open an empty child draft under a parent (subtask-add mode). Reveals it
  // by expanding the parent (a no-op when everything is expanded by default).
  const addSubtaskDraft = useCallback((parentId: string) => {
    setSubtaskDrafts((list) => [...list, { id: crypto.randomUUID(), parentId }]);
    setExpanded((previous) => (previous === true ? previous : { ...previous, [parentId]: true }));
    setRowMenu(null);
  }, []);

  const openRowMenu = useCallback((taskId: string, x: number, y: number) => {
    setRowMenu({ taskId, x, y, showTemplates: false });
  }, []);

  // §C-5 — the row menu closes on outside-click or Escape.
  useEffect(() => {
    if (rowMenu === null) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('[data-testid="row-menu"]') || target?.closest('[data-testid="row-menu-button"]')) return;
      setRowMenu(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setRowMenu(null);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [rowMenu]);

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
      // Reorder only (Design 0003 §C-3): a subtask moves within its parent's
      // children, a root among roots. A drop outside the active row's sibling
      // group returns no commands, so nothing moves and nothing re-parents. The
      // sortOrder rewrite dispatches through the shared batch path — same
      // optimistic-apply → save → reload as every inline edit; the projection
      // re-sorts by (sortOrder, id).
      const commands = reorderSiblingCommands(active, over, rows);
      if (commands.length === 0) return;
      executeCommands(commands);
    },
    [editable, executeCommands, rows],
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
      const renderRow = renderRows[address.rowIndex];
      if (column === undefined || renderRow === undefined || !column.editable || !editable) return;
      setSelected(address);
      setEditing(address);
      // A draft cell starts empty; a real row seeds the editor from its value.
      setEditValue(renderRow.kind === "draft" ? "" : editInitialValue(column, renderRow.row));
    },
    [editable, renderRows],
  );

  const finishEdit = useCallback(
    (persist: boolean) => {
      if (editing === null) return;
      const column = META[editing.colIndex];
      const renderRow = renderRows[editing.rowIndex];
      if (persist && column !== undefined && renderRow !== undefined) {
        if (renderRow.kind === "draft") commitDraft(column, renderRow, editValue);
        else commit(column, renderRow.row, editValue);
      }
      setEditing(null);
    },
    [commit, commitDraft, editValue, editing, renderRows],
  );

  const moveSelection = useCallback(
    (rowDelta: number, colDelta: number) => {
      setSelected((current) => {
        const rowIndex = Math.max(0, Math.min(renderRows.length - 1, current.rowIndex + rowDelta));
        const colIndex = Math.max(0, Math.min(META.length - 1, current.colIndex + colDelta));
        if (rowDelta !== 0) rowVirtualizer.scrollToIndex(rowIndex, { align: "auto" });
        return { rowIndex, colIndex };
      });
    },
    [rowVirtualizer, renderRows.length],
  );

  const copySelection = useCallback(() => {
    const column = META[selected.colIndex];
    const row = taskRowAt(selected.rowIndex);
    if (column === undefined || row === undefined || navigator.clipboard === undefined) return;
    void navigator.clipboard
      .writeText(displayValue(column, row, selected.rowIndex))
      .catch(() => undefined);
  }, [selected, taskRowAt]);

  const pasteSelection = useCallback(() => {
    const column = META[selected.colIndex];
    const row = taskRowAt(selected.rowIndex);
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
  }, [commit, editable, selected, taskRowAt]);

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

  // The inline editor for one editable cell — a master-backed <select> for the
  // 担当 / 工程 / プロダクト columns (Design 0003 §C-6), a text <input> otherwise.
  // Shared by real rows and draft rows. Option value = master id, label = name;
  // the empty option clears the reference.
  const cellEditorSelect = (column: MetaColumn) => {
    if (column.kind === "assignee") return { options: memberOptions, emptyLabel: "— 未割り当て —" };
    if (column.kind === "process") return { options: processOptions, emptyLabel: "—" };
    if (column.kind === "product") return { options: productOptions, emptyLabel: "—" };
    return null;
  };
  const cellEditor = (column: MetaColumn): ReactNode => {
    const select = cellEditorSelect(column);
    return select !== null ? (
      <select
        className="cell-editor"
        autoFocus
        value={editValue}
        onChange={(event) => setEditValue(event.target.value)}
        onBlur={() => finishEdit(true)}
        onKeyDown={onEditorKeyDown}
      >
        <option value="">{select.emptyLabel}</option>
        {select.options.map((option) => (
          <option key={option.id} value={option.id}>{option.name}</option>
        ))}
      </select>
    ) : (
      <input
        className="cell-editor"
        autoFocus
        value={editValue}
        onChange={(event) => setEditValue(event.target.value)}
        onBlur={() => finishEdit(true)}
        onKeyDown={onEditorKeyDown}
      />
    );
  };

  const renderMetaCell = (
    column: MetaColumn,
    colIndex: number,
    row: WbsGridTaskRow,
    rowIndex: number,
    tree?: NameCellTree,
    drag?: DragHandle,
    rollup?: { readonly effortMinutes: number },
  ) => {
    if (column.kind === "index") {
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
          {/* §C-3 — the ⠿ drag grip is the row's leftmost affordance now (the No.
              column is the leftmost column); dragging reorders within the sibling
              scope. The ▲▼ buttons are gone. */}
          <span className="index-lead">
            <span
              ref={drag?.dragRef}
              className="drag-grip"
              data-testid="drag-grip"
              data-task-id={row.id}
              title="ドラッグで並び替え"
              {...(drag?.dragListeners ?? {})}
              {...(drag?.dragAttributes ?? {})}
            >
              ⠿
            </span>
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
          </span>
          <button
            type="button"
            className="row-menu-button"
            data-testid="row-menu-button"
            data-task-id={row.id}
            aria-label="行メニュー"
            title="行メニュー（サブタスク追加・テンプレート）"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              openRowMenu(row.id, event.clientX, event.clientY);
            }}
          >
            ⋯
          </button>
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
    // §C-7 — a collapsed parent surfaces its subtree's total effort in its own
    // 工数(人時)/工数(人日) cells (a display-only summary of the hidden leaves).
    const rollupText =
      rollup !== undefined && column.id === "plannedEffortMinutes"
        ? formatNumber(rollup.effortMinutes / 60)
        : rollup !== undefined && column.id === "plannedEffortDays"
          ? formatNumber(rollup.effortMinutes / 60 / 8)
          : null;
    if (rollupText !== null) classes.push("cell--rollup");
    const style: CSSProperties =
      column.id === "process"
        ? { width: column.width, borderLeft: `3px solid hsl(${processHue(row.processName)} 50% 55%)` }
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
          </span>
        )}
        {isEditing ? (
          cellEditor(column)
        ) : rollupText !== null ? (
          <span className="cell-text" data-testid="rollup-effort" data-task-id={row.id}>
            {rollupText}
          </span>
        ) : (
          <span className="cell-text">{displayValue(column, row, rowIndex)}</span>
        )}
      </div>
    );
  };

  // A draft row's meta cell (§C-4/§C-5): empty, but editable columns open the same
  // inline editor as a real row and commit through `commitDraft`, creating the
  // task. The name column keeps the tree indentation so a subtask draft nests
  // visually under its parent (no chevron/drag handle — a draft is not yet a row).
  const renderDraftCell = (
    column: MetaColumn,
    colIndex: number,
    draft: DraftRenderRow,
    rowIndex: number,
    withTreeIndent: boolean,
  ) => {
    if (column.kind === "index") {
      return (
        <div
          key={column.id}
          className="cell cell--index"
          style={{ width: column.width }}
          role="gridcell"
          data-col={column.id}
          onMouseDown={() => setSelected({ rowIndex, colIndex })}
        >
          <span className="row-no">{rowIndex + 1}</span>
        </div>
      );
    }
    const isSelected = selected.rowIndex === rowIndex && selected.colIndex === colIndex;
    const isEditing = editing?.rowIndex === rowIndex && editing.colIndex === colIndex;
    const classes = ["cell", `cell--${column.kind}`, "cell--draft"];
    if (column.editable) classes.push(editable ? "cell--editable" : "cell--locked");
    if (isSelected) classes.push("cell--selected");
    return (
      <div
        key={column.id}
        className={classes.join(" ")}
        style={{ width: column.width }}
        role="gridcell"
        data-col={column.id}
        onMouseDown={() => setSelected({ rowIndex, colIndex })}
        onDoubleClick={() => column.editable && beginEdit({ rowIndex, colIndex })}
      >
        {withTreeIndent && (
          <span className="tree-affordance" style={{ paddingLeft: draft.depth * 16 }}>
            <span className="tree-toggle-spacer" aria-hidden />
          </span>
        )}
        {isEditing
          ? cellEditor(column)
          : <span className="cell-text cell-text--placeholder">{withTreeIndent ? "新規行…" : ""}</span>}
      </div>
    );
  };

  const rollup = grid.rollup;

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
        {/* §D-1 — the cross-project-load legend, moved off the deleted toolbar into
            a quiet ⓘ affordance; the overlay itself is always on now. */}
        <span
          className="rollup-info"
          data-testid="load-legend"
          role="img"
          aria-label="半透明の帯は担当者が他PJで埋まっている時間。赤いセルはその日の合計工数がキャパ超過。"
          title="半透明の帯は担当者が他PJで埋まっている時間。赤いセルはその日の合計工数がキャパ超過。"
        >
          ⓘ
        </span>
      </section>

      {notice !== null && <div className="notice" role="alert">{notice}</div>}

      {/* One mounted DndContext wraps the tree-only grid so the scroller never
          remounts (spike gotcha #2); per-row drag hooks are always enabled. */}
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
            const rowIndex = virtualRow.index;
            const renderRow = renderRows[rowIndex]!;
            if (renderRow.kind === "draft") {
              return (
                <div
                  key={virtualRow.key}
                  className="grid-row grid-row--draft"
                  role="row"
                  data-testid="draft-row"
                  data-draft-source={renderRow.source}
                  data-draft-parent={renderRow.parentId ?? ""}
                  data-depth={renderRow.depth}
                  style={{ top: virtualRow.start, height: ROW_H, width: dayVirtualizer.getTotalSize() }}
                >
                  <div className="pinned-group" style={{ width: PINNED_WIDTH }}>
                    {PINNED.map((column) =>
                      renderDraftCell(column, META.indexOf(column), renderRow, rowIndex, column.id === "name"),
                    )}
                  </div>
                  {NON_PINNED.map((column, index) => (
                    <div
                      key={column.id}
                      className="cell-slot"
                      style={{ left: NON_PINNED_LEFT[index], width: column.width }}
                    >
                      {renderDraftCell(column, META.indexOf(column), renderRow, rowIndex, false)}
                    </div>
                  ))}
                  {dayVirtualizer.getVirtualItems().map((virtualDay) => (
                    <div
                      key={virtualDay.key}
                      className="daily-cell daily-cell--readonly daily-cell--draft"
                      style={{ left: virtualDay.start, width: DAILY_COL_W }}
                      aria-readonly
                    />
                  ))}
                </div>
              );
            }
            const { row, depth, canExpand, isExpanded, onToggleExpand } = renderRow;
            // §C-7 — a collapsed parent (can expand, currently collapsed) rolls up
            // its hidden subtree; an expanded parent shows nothing extra.
            const collapsedRollup =
              canExpand && !isExpanded ? subtreeRollupById.get(row.id) : undefined;
            return (
              <DndRow
                key={virtualRow.key}
                id={row.id}
                parentId={row.parentId}
                name={row.name}
              >
                {(dnd) => {
                // §C-3 — light a row as a drop target only when the active drag can
                // legally land there: same sibling scope (parentId) and not itself.
                const isDropTarget =
                  dnd.isOver &&
                  activeDrag !== null &&
                  activeDrag.id !== row.id &&
                  activeDrag.parentId === row.parentId;
                return (
              <div
                ref={dnd.dropRef}
                className={`grid-row ${row.parentId === null ? "grid-row--parent" : "grid-row--child"}${rowWarningById.has(row.id) ? " grid-row--warning" : ""}${isDropTarget ? " grid-row--drop-target" : ""}`}
                role="row"
                data-warning={rowWarningById.has(row.id) ? "true" : undefined}
                data-row-id={row.id}
                data-depth={depth}
                style={{ top: virtualRow.start, height: ROW_H, width: dayVirtualizer.getTotalSize() }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  openRowMenu(row.id, event.clientX, event.clientY);
                }}
              >
                <div className="pinned-group" style={{ width: PINNED_WIDTH }}>
                  {PINNED.map((column) =>
                    renderMetaCell(
                      column,
                      META.indexOf(column),
                      row,
                      rowIndex,
                      column.id === "name"
                        ? { depth, canExpand, isExpanded, onToggleExpand }
                        : undefined,
                      column.id === "no"
                        ? {
                            dragRef: dnd.dragRef,
                            dragListeners: dnd.dragListeners,
                            dragAttributes: dnd.dragAttributes,
                          }
                        : undefined,
                      collapsedRollup,
                    ),
                  )}
                </div>
                {NON_PINNED.map((column, index) => (
                  <div
                    key={column.id}
                    className="cell-slot"
                    style={{ left: NON_PINNED_LEFT[index], width: column.width }}
                  >
                    {renderMetaCell(column, META.indexOf(column), row, rowIndex, undefined, undefined, collapsedRollup)}
                  </div>
                ))}
                {dayVirtualizer.getVirtualItems().map((virtualDay) => {
                  const date = days[virtualDay.index]!;
                  const minutes = row.dailyPlan[date] ?? 0;
                  // §C-7 — a collapsed parent shows the Σ of that day across its
                  // hidden descendants instead of its own (empty) plan; the cell is
                  // then a read-only summary, not an editable plan cell.
                  const rollupMinutes = collapsedRollup?.daily.get(date) ?? 0;
                  const showRollup = collapsedRollup !== undefined;
                  const displayMinutes = showRollup ? rollupMinutes : minutes;
                  // Shared weekend/holiday (grey) takes precedence over the
                  // assignee's paid leave (violet); either blocks editing. Every
                  // working day is hand-editable now (Design 0003 §C-2: no lock).
                  const nonWorking = sharedNonWorkingDates.has(date);
                  const paidLeave = !nonWorking && isPaidLeave(row.assigneeMemberId, date);
                  const cellEditable = editable && !nonWorking && !paidLeave && !showRollup;
                  const isEditing =
                    dailyEditing?.rowId === row.id && dailyEditing.date === date;
                  // Cross-project overlay + overflow, per the row's assignee.
                  const assignee = row.assigneeMemberId;
                  const externalMinutes =
                    assignee !== null ? externalMinutesFor(externalLoad, assignee, date) : 0;
                  const capacity = assignee !== null ? capacityByMember.get(assignee) : undefined;
                  const loadFraction =
                    externalMinutes > 0 && capacity !== undefined
                      ? Math.min(1, externalMinutes / capacity)
                      : 0;
                  const overloadEntry =
                    assignee !== null ? overloadByKey.get(overloadKey(assignee, date)) : undefined;
                  const classes = ["daily-cell"];
                  if (showRollup) {
                    if (rollupMinutes > 0) classes.push("daily-cell--rollup");
                  } else if (minutes > 0) {
                    classes.push("daily-cell--filled");
                  }
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
                      data-daily-rollup={showRollup ? "true" : undefined}
                      data-overload={overloadEntry !== undefined ? "true" : undefined}
                      aria-readonly={cellEditable ? undefined : true}
                      title={
                        overloadEntry !== undefined
                          ? `⚠ 工数超過 ${date.slice(5)}: 合計 ${formatNumber(overloadEntry.totalMinutes / 60)}h（本PJ ${formatNumber(overloadEntry.projectMinutes / 60)}h + 他PJ ${formatNumber(overloadEntry.externalMinutes / 60)}h）＞ 上限 ${formatNumber(overloadEntry.capacityMinutes / 60)}h`
                          : showRollup
                            ? "配下の日別合計（折畳中）"
                            : externalMinutes > 0
                              ? `他PJ負荷 ${formatNumber(externalMinutes / 60)}h`
                              : cellEditable
                                ? "日別計画 — ダブルクリックで編集"
                                : "日別計画（非稼働日）"
                      }
                      onDoubleClick={() => { if (!showRollup) beginDailyEdit(row, date); }}
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
                        ) : displayMinutes > 0 ? (
                          formatNumber(displayMinutes / 60)
                        ) : (
                          ""
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
                );
                }}
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

      {/* §C-4 — grow the tail draft rows by n (1–1000). Minimal footer control, not
          a toolbar: it just appends empty rows a person then types into. */}
      <footer className="add-rows" data-testid="add-rows">
        <button
          type="button"
          className="add-rows-button"
          data-testid="add-rows-button"
          disabled={!editable}
          onClick={() => setDraftCount((current) => current + addRowsCount)}
        >
          + {addRowsCount} 行追加
        </button>
        <input
          type="number"
          className="add-rows-count"
          data-testid="add-rows-count"
          min={1}
          max={1000}
          value={addRowsCount}
          aria-label="追加する行数"
          onChange={(event) => {
            const next = Math.trunc(Number(event.target.value));
            if (!Number.isFinite(next)) return;
            setAddRowsCount(Math.max(1, Math.min(1000, next)));
          }}
        />
      </footer>

      {/* §C-5 — the row action menu (⋯ / right-click). Fixed-positioned at the
          click, closed on outside-click / Escape (see effect above). */}
      {rowMenu !== null && (
        <div
          className="row-menu"
          data-testid="row-menu"
          role="menu"
          style={{ position: "fixed", left: rowMenu.x, top: rowMenu.y }}
        >
          {rowMenu.showTemplates ? (
            project.templates.length === 0 ? (
              <span className="row-menu-empty" data-testid="row-menu-templates-empty">
                テンプレートがありません
              </span>
            ) : (
              [...project.templates]
                .sort(
                  (left, right) =>
                    left.sortOrder - right.sortOrder || left.id.localeCompare(right.id),
                )
                .map((template) => (
                  <button
                    key={template.id}
                    type="button"
                    className="row-menu-item"
                    role="menuitem"
                    data-testid="row-menu-template"
                    data-template-id={template.id}
                    onClick={() => generateSubtasks(rowMenu.taskId, template.id)}
                  >
                    {template.name}
                  </button>
                ))
            )
          ) : (
            <>
              <button
                type="button"
                className="row-menu-item"
                role="menuitem"
                data-testid="row-menu-add-subtask"
                onClick={() => addSubtaskDraft(rowMenu.taskId)}
              >
                サブタスクを追加
              </button>
              <button
                type="button"
                className="row-menu-item"
                role="menuitem"
                data-testid="row-menu-templates"
                onClick={() => setRowMenu((menu) => (menu === null ? null : { ...menu, showTemplates: true }))}
              >
                テンプレートから生成…
              </button>
            </>
          )}
        </div>
      )}
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
