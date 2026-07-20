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
import { ProjectApiError, type ProjectApiClient } from "./project-api-client";

const HEADER_H = 46;
const ROW_H = 30;
const DAILY_COL_W = 48;

type ColKind =
  | "index"
  | "lock"
  | "text"
  | "assignee"
  | "hours"
  | "weight"
  | "progress"
  | "date"
  | "derivedNum"
  | "derivedPercent"
  | "derivedDate"
  | "status";

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
}

// Japanese column headers follow the source worksheet. Numeric EVM columns spell
// out the metric in Japanese with its unit in parentheses; the PV/EV/AC/CV
// abbreviations survive only in the top rollup tiles.
const META: readonly MetaColumn[] = [
  { id: "lock", header: "ロック", width: 44, pinned: true, editable: false, kind: "lock" },
  { id: "no", header: "No.", width: 72, pinned: true, editable: false, kind: "index" },
  { id: "process", header: "工程", width: 104, pinned: true, editable: true, kind: "text", field: "process" },
  { id: "name", header: "タスク・サブタスク", width: 240, pinned: true, editable: true, kind: "text", field: "name" },
  { id: "assignee", header: "担当", width: 120, pinned: true, editable: true, kind: "assignee", field: "assigneeMemberId" },
  { id: "product", header: "プロダクト", width: 108, pinned: false, editable: true, kind: "text", field: "product" },
  { id: "reviewRef", header: "レビュー管理No", width: 116, pinned: false, editable: true, kind: "text", field: "reviewRef" },
  { id: "changeRef", header: "変更管理", width: 96, pinned: false, editable: true, kind: "text", field: "changeRef" },
  { id: "note", header: "備考", width: 140, pinned: false, editable: true, kind: "text", field: "note" },
  { id: "contract", header: "契約", width: 96, pinned: false, editable: true, kind: "text", field: "contract" },
  { id: "plannedEffortDays", header: "工数(人日)", width: 92, pinned: false, editable: false, kind: "derivedNum" },
  { id: "plannedEffortMinutes", header: "工数(人時)", width: 92, pinned: false, editable: true, kind: "hours", field: "plannedEffortMinutes" },
  { id: "prorationWeightBp", header: "重み", width: 72, pinned: false, editable: true, kind: "weight", field: "prorationWeightBp" },
  { id: "plannedEffortHours", header: "計画工数(人時)", width: 108, pinned: false, editable: false, kind: "derivedNum" },
  { id: "plannedEarnedHours", header: "計画進捗工数(人時)", width: 116, pinned: false, editable: false, kind: "derivedNum" },
  { id: "plannedProgress", header: "進捗率(計画)", width: 96, pinned: false, editable: false, kind: "derivedPercent" },
  { id: "plannedStart", header: "開始予定", width: 92, pinned: false, editable: false, kind: "derivedDate" },
  { id: "plannedFinish", header: "終了予定", width: 92, pinned: false, editable: false, kind: "derivedDate" },
  { id: "actualStart", header: "開始日", width: 88, pinned: false, editable: true, kind: "date", field: "actualStart" },
  { id: "actualFinish", header: "終了日", width: 88, pinned: false, editable: true, kind: "date", field: "actualFinish" },
  { id: "progress", header: "進捗率", width: 84, pinned: false, editable: true, kind: "progress", field: "progressBasisPoints" },
  { id: "status", header: "ステータス", width: 96, pinned: false, editable: false, kind: "status" },
  { id: "earnedEffortHours", header: "実績進捗工数(人時)", width: 116, pinned: false, editable: false, kind: "derivedNum" },
  { id: "actualEffortMinutes", header: "実績投入工数(人時)", width: 116, pinned: false, editable: true, kind: "hours", field: "actualEffortMinutes" },
  { id: "costVarianceHours", header: "コスト差異(人時)", width: 108, pinned: false, editable: false, kind: "derivedNum" },
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
    case "lock":
      return row.dailyPlanLocked ? "Locked" : "Unlocked";
    case "text":
      return String(row[column.field as keyof WbsGridTaskRow] ?? "");
    case "assignee":
      return row.assigneeName ?? "";
    case "hours":
      return formatNumber((row[column.field as keyof WbsGridTaskRow] as number) / 60);
    case "weight":
      return row.prorationWeightBp === null ? "" : String(row.prorationWeightBp);
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
    case "prorationWeightBp": {
      // Basis points (0–10000). Empty clears the weight (un-prorates the task); a
      // valid whole number re-weights it, and the shared re-proration keeps the
      // parent's effort split across its weighted children.
      if (trimmed === "") return { prorationWeightBp: null };
      const bp = Number(trimmed);
      if (!Number.isInteger(bp) || bp < 0 || bp > 10_000) return null;
      return { prorationWeightBp: bp };
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
    case "reviewRef":
      return { reviewRef: raw };
    case "changeRef":
      return { changeRef: raw };
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
 * Build the task.update change set for a hand edit of one daily cell. Only
 * **locked** tasks own their daily plan (unlocked cells are scheduler-authored
 * and read-only); a hand edit therefore always re-asserts `dailyPlanLocked`, the
 * D17 "hand-edit is manual-lock" invariant, alongside the full replacement plan.
 * Returns null when the entered hours are malformed. A zero clears the day.
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
  return { dailyPlan, dailyPlanLocked: true };
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
  // The preview's daily plot is generated by the same deterministic scheduler
  // the server runs (ADR 0011 Decision 4): unlocked tasks are auto-placed
  // honoring dependencies, capacity, and holidays, while the seeded locked row
  // keeps its hand-entered plan verbatim (applyEffortSchedule skips it).
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

  const days = useMemo(() => {
    const set = new Set<string>();
    for (const row of rows) {
      for (const date of Object.keys(row.dailyPlan)) set.add(date);
    }
    return [...set].sort();
  }, [rows]);

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
      // In preview (no backend) also run the deterministic scheduler so generated
      // subtasks are auto-placed exactly as the server write path does
      // (applyProjectCommand → applyEffortSchedule); with a backend the reload
      // after the command restores the server-scheduled plans.
      const optimistic = client === undefined ? applyEffortSchedule(candidate) : candidate;
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
        reviewRef: "",
        changeRef: "",
        note: "",
        contract: "",
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

  const toggleLock = useCallback(
    (row: WbsGridTaskRow) => {
      if (!editable) return;
      executeCommand({
        type: "task.update",
        taskId: row.id,
        changes: { dailyPlanLocked: !row.dailyPlanLocked },
      });
    },
    [editable, executeCommand],
  );

  const beginDailyEdit = useCallback(
    (row: WbsGridTaskRow, date: string) => {
      // Only locked tasks may hand-edit their daily plot; unlocked cells belong
      // to the scheduler and stay read-only (ADR 0011 Decision 3).
      if (!editable || !row.dailyPlanLocked) return;
      setDailyEditing({ rowId: row.id, date });
      const minutes = row.dailyPlan[date] ?? 0;
      setDailyEditValue(minutes > 0 ? formatNumber(minutes / 60) : "");
    },
    [editable],
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
    if (column.kind === "lock") {
      const locked = row.dailyPlanLocked;
      return (
        <div
          key={column.id}
          className="cell cell--lock"
          style={{ width: column.width }}
          role="gridcell"
          data-col={column.id}
          onMouseDown={() => setSelected({ rowIndex, colIndex })}
        >
          <button
            type="button"
            className={`lock-toggle ${locked ? "lock-toggle--locked" : "lock-toggle--unlocked"}`}
            data-testid="lock-toggle"
            data-task-id={row.id}
            data-locked={locked ? "true" : "false"}
            aria-pressed={locked}
            aria-label={locked ? "ロック中 — 日別計画は手入力。クリックで解除" : "自動スケジュール — クリックしてロックし手入力"}
            title={locked ? "ロック中: 日別計画は手入力です。クリックでスケジューラに戻します。" : "自動スケジュール。クリックでロックして日別計画を手入力します。"}
            disabled={!editable}
            onClick={() => toggleLock(row)}
          >
            {locked ? "🔒" : "🔓"}
          </button>
        </div>
      );
    }
    if (column.kind === "index") {
      const bounds = siblingBounds.get(row.id);
      const canMoveUp = editable && bounds?.prevId != null;
      const canMoveDown = editable && bounds?.nextId != null;
      const indexSelected = selected.rowIndex === rowIndex && selected.colIndex === colIndex;
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

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <h1>VECTA</h1>
          <p className="app-subtitle">
            {project.name ? `${project.name} · ` : ""}基準日 {grid.statusDate} · {rows.length.toLocaleString()} タスク · {days.length} 計画日
          </p>
        </div>
        <div className={`save-badge save-badge--${saveState}`} data-testid="save-state">{saveState}</div>
      </header>

      <section className="rollup" aria-label="プロジェクト集計" data-testid="rollup">
        <RollupTile label="BAC (人日)" value={formatNumber(rollup.bac)} />
        <RollupTile label="PV (人日)" value={formatNumber(rollup.pv)} />
        <RollupTile label="EV (人日)" value={formatNumber(rollup.ev)} />
        <RollupTile label="AC (人日)" value={formatNumber(rollup.ac)} />
        <RollupTile label="SV (人日)" value={formatNumber(rollup.sv)} tone={rollup.sv < 0 ? "risk" : "ok"} />
        <RollupTile label="CV (人日)" value={formatNumber(rollup.cv)} tone={rollup.cv < 0 ? "risk" : "ok"} />
        <RollupTile label="SPI" value={rollup.spi === "-" ? "—" : rollup.spi.toFixed(2)} />
        <RollupTile label="CPI" value={rollup.cpi === "-" ? "—" : rollup.cpi.toFixed(2)} />
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
            <div className="pinned-group pinned-group--header" style={{ width: PINNED_WIDTH }}>
              {PINNED.map((column) => (
                <div key={column.id} className="head-cell" style={{ width: column.width }} title={column.header}>
                  <span className="head-label">{column.header}</span>
                </div>
              ))}
            </div>
            {NON_PINNED.map((column, index) => (
              <div
                key={column.id}
                className="head-cell head-cell--abs"
                style={{ left: NON_PINNED_LEFT[index], width: column.width }}
                title={column.header}
              >
                <span className="head-label">{column.header}</span>
              </div>
            ))}
            {dayVirtualizer.getVirtualItems().map((virtualDay) => {
              const date = days[virtualDay.index]!;
              return (
                <div
                  key={virtualDay.key}
                  className="head-cell head-cell--day"
                  style={{ left: virtualDay.start, width: DAILY_COL_W }}
                  title={date}
                >
                  {date.slice(5)}
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
                className={`grid-row ${row.parentId === null ? "grid-row--parent" : "grid-row--child"}${row.dailyPlanLocked ? " grid-row--locked" : ""}${dnd.isOver ? " grid-row--drop-target" : ""}`}
                role="row"
                data-locked={row.dailyPlanLocked ? "true" : "false"}
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
                  const locked = row.dailyPlanLocked;
                  const cellEditable = locked && editable;
                  const isEditing =
                    dailyEditing?.rowId === row.id && dailyEditing.date === date;
                  const classes = ["daily-cell"];
                  if (minutes > 0) classes.push("daily-cell--filled");
                  classes.push(cellEditable ? "daily-cell--editable" : "daily-cell--readonly");
                  return (
                    <div
                      key={virtualDay.key}
                      className={classes.join(" ")}
                      style={{ left: virtualDay.start, width: DAILY_COL_W }}
                      data-daily-row={row.id}
                      data-daily-date={date}
                      aria-readonly={cellEditable ? undefined : true}
                      title={
                        locked
                          ? cellEditable
                            ? "手入力の日別計画 — ダブルクリックで編集"
                            : "手入力の日別計画"
                          : "自動スケジュール — タスクをロックすると手入力できます"
                      }
                      onDoubleClick={() => beginDailyEdit(row, date)}
                    >
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

function RollupTile({ label, value, tone }: { readonly label: string; readonly value: string; readonly tone?: "ok" | "risk" }) {
  return (
    <div className={`rollup-tile ${tone === "risk" ? "rollup-tile--risk" : ""}`}>
      <span className="rollup-label">{label}</span>
      <strong className="rollup-value">{value}</strong>
    </div>
  );
}
