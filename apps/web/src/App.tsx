import {
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  applyProjectCommand,
  projectWbsGrid,
  type ProjectCommand,
  type ProjectState,
  type ProjectTask,
  type WbsGridProjection,
  type WbsGridTaskRow,
} from "@earned-signal/application";
import type { TaskStatus } from "@earned-signal/domain";
import { createDemoProject } from "./demo-project";
import { ProjectApiError, type ProjectApiClient } from "./project-api-client";

const HEADER_H = 46;
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

interface MetaColumn {
  readonly id: string;
  readonly letter: string;
  readonly header: string;
  readonly width: number;
  readonly pinned: boolean;
  readonly editable: boolean;
  readonly kind: ColKind;
  /** Stored input field edited by this column (editable columns only). */
  readonly field?: keyof WbsGridTaskRow;
}

const META: readonly MetaColumn[] = [
  { id: "no", letter: "A", header: "No.", width: 60, pinned: true, editable: false, kind: "index" },
  { id: "process", letter: "B", header: "Process", width: 128, pinned: true, editable: true, kind: "text", field: "process" },
  { id: "name", letter: "D/F", header: "Task / Subtask", width: 240, pinned: true, editable: true, kind: "text", field: "name" },
  { id: "assignee", letter: "J", header: "Assignee", width: 132, pinned: true, editable: true, kind: "assignee", field: "assigneeMemberId" },
  { id: "product", letter: "C", header: "Product", width: 120, pinned: false, editable: true, kind: "text", field: "product" },
  { id: "reviewRef", letter: "E", header: "Review", width: 110, pinned: false, editable: true, kind: "text", field: "reviewRef" },
  { id: "changeRef", letter: "G", header: "Change", width: 110, pinned: false, editable: true, kind: "text", field: "changeRef" },
  { id: "note", letter: "H", header: "Note", width: 160, pinned: false, editable: true, kind: "text", field: "note" },
  { id: "contract", letter: "I", header: "Contract", width: 120, pinned: false, editable: true, kind: "text", field: "contract" },
  { id: "plannedEffortDays", letter: "K", header: "Effort (pd)", width: 84, pinned: false, editable: false, kind: "derivedNum" },
  { id: "plannedEffortMinutes", letter: "L", header: "Effort (ph)", width: 90, pinned: false, editable: true, kind: "hours", field: "plannedEffortMinutes" },
  { id: "plannedEffortHours", letter: "M", header: "PV (ph)", width: 88, pinned: false, editable: false, kind: "derivedNum" },
  { id: "plannedEarnedHours", letter: "N", header: "Earned (ph)", width: 92, pinned: false, editable: false, kind: "derivedNum" },
  { id: "plannedProgress", letter: "O", header: "Plan %", width: 78, pinned: false, editable: false, kind: "derivedPercent" },
  { id: "plannedStart", letter: "P", header: "Plan start", width: 100, pinned: false, editable: false, kind: "derivedDate" },
  { id: "plannedFinish", letter: "Q", header: "Plan finish", width: 100, pinned: false, editable: false, kind: "derivedDate" },
  { id: "actualStart", letter: "R", header: "Act. start", width: 104, pinned: false, editable: true, kind: "date", field: "actualStart" },
  { id: "actualFinish", letter: "S", header: "Act. finish", width: 104, pinned: false, editable: true, kind: "date", field: "actualFinish" },
  { id: "progress", letter: "T", header: "Progress", width: 88, pinned: false, editable: true, kind: "progress", field: "progressBasisPoints" },
  { id: "status", letter: "U", header: "Status", width: 112, pinned: false, editable: false, kind: "status" },
  { id: "earnedEffortHours", letter: "V", header: "EV (ph)", width: 88, pinned: false, editable: false, kind: "derivedNum" },
  { id: "actualEffortMinutes", letter: "W", header: "AC (ph)", width: 90, pinned: false, editable: true, kind: "hours", field: "actualEffortMinutes" },
  { id: "costVarianceHours", letter: "X", header: "CV (ph)", width: 90, pinned: false, editable: false, kind: "derivedNum" },
];

const PINNED = META.filter((column) => column.pinned);
const NON_PINNED = META.filter((column) => !column.pinned);
const PINNED_WIDTH = PINNED.reduce((sum, column) => sum + column.width, 0);
const META_WIDTH = PINNED_WIDTH + NON_PINNED.reduce((sum, column) => sum + column.width, 0);

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
  NOT_STARTED: "Not started",
  IN_PROGRESS: "In progress",
  DONE: "Done",
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

export function App({ client }: { readonly client?: ProjectApiClient }) {
  const [project, setProject] = useState<ProjectState>(() =>
    client === undefined ? createDemoProject() : EMPTY_PROJECT,
  );
  const [grid, setGrid] = useState<WbsGridProjection>(() => projectWbsGrid(project));
  const [revision, setRevision] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>(client === undefined ? "preview" : "loading");
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<CellAddress>({ rowIndex: 0, colIndex: 0 });
  const [editing, setEditing] = useState<CellAddress | null>(null);
  const [editValue, setEditValue] = useState("");
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

  const columns = useMemo<ColumnDef<WbsGridTaskRow>[]>(
    () => META.map((column) => ({ id: column.id, header: column.header, accessorKey: "id" })),
    [],
  );
  const table = useReactTable({
    data: rows,
    columns,
    getRowId: (row) => row.id,
    getCoreRowModel: getCoreRowModel(),
  });
  const modelRows = table.getRowModel().rows;

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

  const executeCommand = useCallback(
    (command: ProjectCommand): boolean => {
      if (saving.current) return false;
      const previousProject = project;
      const previousGrid = grid;
      let candidate: ProjectState;
      try {
        candidate = applyProjectCommand(project, command);
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "The edit could not be applied");
        return false;
      }
      // Optimistic recompute of the derived columns via the shared effort module.
      setProject(candidate);
      setGrid(projectWbsGrid(candidate));
      setNotice(null);
      if (client !== undefined && revision !== null) {
        saving.current = true;
        setSaveState("saving");
        client
          .execute(command, revision)
          .then(async (result) => {
            setRevision(result.revision);
            setSaveState("saved");
            try {
              await reload();
            } catch {
              setNotice(`Saved at revision ${result.revision}, but the grid could not be refreshed. Reload to retrieve derived values.`);
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

  const beginEdit = useCallback(
    (address: CellAddress) => {
      const column = META[address.colIndex];
      const row = rows[address.rowIndex];
      if (column === undefined || row === undefined || !column.editable || !editable) return;
      setSelected(address);
      setEditing(address);
      setEditValue(editInitialValue(column, row));
    },
    [editable, rows],
  );

  const finishEdit = useCallback(
    (persist: boolean) => {
      if (editing === null) return;
      const column = META[editing.colIndex];
      const row = rows[editing.rowIndex];
      if (persist && column !== undefined && row !== undefined) {
        commit(column, row, editValue);
      }
      setEditing(null);
    },
    [commit, editValue, editing, rows],
  );

  const moveSelection = useCallback(
    (rowDelta: number, colDelta: number) => {
      setSelected((current) => {
        const rowIndex = Math.max(0, Math.min(rows.length - 1, current.rowIndex + rowDelta));
        const colIndex = Math.max(0, Math.min(META.length - 1, current.colIndex + colDelta));
        if (rowDelta !== 0) rowVirtualizer.scrollToIndex(rowIndex, { align: "auto" });
        return { rowIndex, colIndex };
      });
    },
    [rowVirtualizer, rows.length],
  );

  const copySelection = useCallback(() => {
    const column = META[selected.colIndex];
    const row = rows[selected.rowIndex];
    if (column === undefined || row === undefined || navigator.clipboard === undefined) return;
    void navigator.clipboard
      .writeText(displayValue(column, row, selected.rowIndex))
      .catch(() => undefined);
  }, [rows, selected]);

  const pasteSelection = useCallback(() => {
    const column = META[selected.colIndex];
    const row = rows[selected.rowIndex];
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
  }, [commit, editable, rows, selected]);

  const onGridKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (editing !== null) return;
      if (event.key === "ArrowDown") { event.preventDefault(); moveSelection(1, 0); return; }
      if (event.key === "ArrowUp") { event.preventDefault(); moveSelection(-1, 0); return; }
      if (event.key === "ArrowRight") { event.preventDefault(); moveSelection(0, 1); return; }
      if (event.key === "ArrowLeft") { event.preventDefault(); moveSelection(0, -1); return; }
      if (event.key === "Enter" || event.key === "F2") { event.preventDefault(); beginEdit(selected); return; }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "c") { event.preventDefault(); copySelection(); return; }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "v") { event.preventDefault(); pasteSelection(); return; }
    },
    [beginEdit, copySelection, editing, moveSelection, pasteSelection, selected],
  );

  const onEditorKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement | HTMLSelectElement>) => {
      if (event.key === "Enter") { event.preventDefault(); finishEdit(true); }
      else if (event.key === "Escape") { event.preventDefault(); finishEdit(false); }
    },
    [finishEdit],
  );

  const renderMetaCell = (column: MetaColumn, colIndex: number, row: WbsGridTaskRow, rowIndex: number) => {
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
        ? { width: column.width, borderLeft: `4px solid hsl(${processHue(row.process)} 60% 52%)` }
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
                <option value="">— Unassigned —</option>
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

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <h1>{project.name || "EarnedSignal"}</h1>
          <p className="app-subtitle">
            Effort WBS · status date {grid.statusDate} · {rows.length.toLocaleString()} tasks · {days.length} plan days
          </p>
        </div>
        <div className={`save-badge save-badge--${saveState}`} data-testid="save-state">{saveState}</div>
      </header>

      <section className="rollup" aria-label="Project rollup" data-testid="rollup">
        <RollupTile label="BAC (pd)" value={formatNumber(rollup.bac)} />
        <RollupTile label="PV (pd)" value={formatNumber(rollup.pv)} />
        <RollupTile label="EV (pd)" value={formatNumber(rollup.ev)} />
        <RollupTile label="AC (pd)" value={formatNumber(rollup.ac)} />
        <RollupTile label="SV (pd)" value={formatNumber(rollup.sv)} tone={rollup.sv < 0 ? "risk" : "ok"} />
        <RollupTile label="CV (pd)" value={formatNumber(rollup.cv)} tone={rollup.cv < 0 ? "risk" : "ok"} />
        <RollupTile label="SPI" value={rollup.spi === "-" ? "—" : rollup.spi.toFixed(2)} />
        <RollupTile label="CPI" value={rollup.cpi === "-" ? "—" : rollup.cpi.toFixed(2)} />
      </section>

      {notice !== null && <div className="notice" role="alert">{notice}</div>}

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
                <div key={column.id} className="head-cell" style={{ width: column.width }}>
                  <span className="head-letter">{column.letter}</span>
                  <span className="head-label">{column.header}</span>
                </div>
              ))}
            </div>
            {NON_PINNED.map((column, index) => (
              <div
                key={column.id}
                className="head-cell head-cell--abs"
                style={{ left: NON_PINNED_LEFT[index], width: column.width }}
              >
                <span className="head-letter">{column.letter}</span>
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
            const row = modelRows[virtualRow.index]!.original;
            const rowIndex = virtualRow.index;
            return (
              <div
                key={virtualRow.key}
                className={`grid-row ${row.parentId === null ? "grid-row--parent" : "grid-row--child"}`}
                role="row"
                style={{ top: virtualRow.start, height: ROW_H, width: dayVirtualizer.getTotalSize() }}
              >
                <div className="pinned-group" style={{ width: PINNED_WIDTH }}>
                  {PINNED.map((column) =>
                    renderMetaCell(column, META.indexOf(column), row, rowIndex),
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
                  const minutes = row.dailyPlan[days[virtualDay.index]!] ?? 0;
                  return (
                    <div
                      key={virtualDay.key}
                      className={`daily-cell ${minutes > 0 ? "daily-cell--filled" : ""}`}
                      style={{ left: virtualDay.start, width: DAILY_COL_W }}
                    >
                      {minutes > 0 ? formatNumber(minutes / 60) : ""}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
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
