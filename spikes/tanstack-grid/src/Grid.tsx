import { useCallback, useMemo, useRef, useState } from 'react';
import {
  getCoreRowModel,
  getExpandedRowModel,
  useReactTable,
  type ColumnDef,
  type ExpandedState,
  type Row,
} from '@tanstack/react-table';
import { useVirtualizer, type VirtualItem } from '@tanstack/react-virtual';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { DAY_COUNT, generateData, type Task } from './data';
import {
  DAY_W,
  HEADER_H,
  META_COLS,
  META_WIDTH,
  PINNED_META,
  PINNED_WIDTH,
  ROW_H,
  SCROLL_META,
  TOTAL_WIDTH,
  dayHeader,
} from './layout';

interface DragData {
  id: string;
  depth: number;
  parentId: string | undefined;
  label: string;
}

// ---- Header (sticky top; pinned group sticky left) ----------------------------

function HeaderRow({ virtualCols }: { virtualCols: VirtualItem[] }) {
  return (
    <div className="header" style={{ height: HEADER_H, width: TOTAL_WIDTH }}>
      <div className="pinned-group header-pinned" style={{ width: PINNED_WIDTH, height: HEADER_H }}>
        {PINNED_META.map((mc) => (
          <div key={mc.id} className="cell head" style={{ left: mc.left, width: mc.width, height: HEADER_H }}>
            {mc.header}
          </div>
        ))}
      </div>
      {SCROLL_META.map((mc) => (
        <div key={mc.id} className="cell head" style={{ position: 'absolute', left: mc.left, width: mc.width, height: HEADER_H }}>
          {mc.header}
        </div>
      ))}
      {virtualCols.map((vc) => (
        <div key={vc.key} className="cell head day" style={{ position: 'absolute', left: vc.start, width: DAY_W, height: HEADER_H }}>
          {dayHeader(vc.index)}
        </div>
      ))}
    </div>
  );
}

// ---- Row rendering (shared by the DnD and plain variants) ---------------------

interface RowInnerProps {
  row: Row<Task>;
  top: number;
  virtualCols: VirtualItem[];
  rootRef?: (el: HTMLElement | null) => void;
  handleRef?: (el: HTMLElement | null) => void;
  handleProps?: Record<string, unknown>;
  isOver?: boolean;
  isDragging?: boolean;
}

function RowInner({ row, top, virtualCols, rootRef, handleRef, handleProps, isOver, isDragging }: RowInnerProps) {
  const t = row.original;
  return (
    <div
      data-row
      ref={rootRef}
      className={`row ${row.depth ? 'child' : 'parent'}${isOver ? ' over' : ''}`}
      style={{ top, height: ROW_H, width: TOTAL_WIDTH, opacity: isDragging ? 0.35 : 1 }}
    >
      <div ref={handleRef} {...(handleProps ?? {})} className="pinned-group row-pinned" style={{ width: PINNED_WIDTH, height: ROW_H }}>
        {PINNED_META.map((mc) => {
          if (mc.id === 'task') {
            return (
              <div data-cell key={mc.id} className="cell task-cell" style={{ left: mc.left, width: mc.width, height: ROW_H }}>
                <span className="indent" style={{ width: row.depth * 16 }} />
                {row.getCanExpand() ? (
                  <button
                    className="toggle"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      row.getToggleExpandedHandler()();
                    }}
                  >
                    {row.getIsExpanded() ? '▼' : '▶'}
                  </button>
                ) : (
                  <span className="toggle-spacer" />
                )}
                <span className="task-label">{String(mc.accessor(t))}</span>
              </div>
            );
          }
          return (
            <div data-cell key={mc.id} className="cell" style={{ left: mc.left, width: mc.width, height: ROW_H }}>
              {String(mc.accessor(t))}
            </div>
          );
        })}
      </div>
      {SCROLL_META.map((mc) => (
        <div data-cell key={mc.id} className="cell" style={{ position: 'absolute', left: mc.left, width: mc.width, height: ROW_H }}>
          {String(mc.accessor(t))}
        </div>
      ))}
      {virtualCols.map((vc) => {
        const v = t.days[vc.index];
        return (
          <div data-cell data-daycell key={vc.key} className="cell day" style={{ position: 'absolute', left: vc.start, width: DAY_W, height: ROW_H }}>
            {v || ''}
          </div>
        );
      })}
    </div>
  );
}

function RowViewDnd(props: { row: Row<Task>; top: number; virtualCols: VirtualItem[] }) {
  const { row } = props;
  const parentId = row.getParentRow()?.id;
  const data: DragData = { id: row.id, depth: row.depth, parentId, label: row.original.task };
  const drop = useDroppable({ id: `drop-${row.id}`, data });
  const drag = useDraggable({ id: `drag-${row.id}`, data });
  return (
    <RowInner
      {...props}
      rootRef={drop.setNodeRef}
      handleRef={drag.setNodeRef}
      handleProps={{ ...drag.listeners, ...drag.attributes }}
      isOver={drop.isOver}
      isDragging={drag.isDragging}
    />
  );
}

function RowViewPlain(props: { row: Row<Task>; top: number; virtualCols: VirtualItem[] }) {
  return <RowInner {...props} />;
}

// ---- Grid ---------------------------------------------------------------------

export function Grid() {
  const initial = useMemo(() => generateData(3000), []);
  const [tree, setTree] = useState<Task[]>(initial.tree);
  const [expanded, setExpanded] = useState<ExpandedState>(() =>
    Object.fromEntries(initial.parentIds.map((id) => [id, true])),
  );
  const [dndEnabled, setDndEnabled] = useState(true);
  const [activeLabel, setActiveLabel] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Callback ref: keeps both the virtualizer's scroll element and the perf handle
  // pointing at the live node, even if the scroller ever remounts.
  const setScroller = useCallback((el: HTMLDivElement | null) => {
    scrollRef.current = el;
    if (!window.__grid) window.__grid = { scroller: null };
    window.__grid.scroller = el;
  }, []);

  const columns = useMemo<ColumnDef<Task>[]>(() => {
    const meta: ColumnDef<Task>[] = META_COLS.map((mc) => ({ id: mc.id, accessorFn: mc.accessor, header: mc.header }));
    const days: ColumnDef<Task>[] = Array.from({ length: DAY_COUNT }, (_, i) => ({
      id: `d${i}`,
      accessorFn: (r: Task) => r.days[i],
      header: dayHeader(i),
    }));
    return [...meta, ...days];
  }, []);

  const table = useReactTable({
    data: tree,
    columns,
    state: { expanded },
    onExpandedChange: setExpanded,
    getSubRows: (row) => row.subRows,
    getRowId: (row) => row.id,
    getCoreRowModel: getCoreRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
  });

  const rows = table.getRowModel().rows;

  // paddingStart reserves the sticky header band so virtual row `start` values are
  // in the same coordinate space as the actual (header-offset) render positions.
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 12,
    paddingStart: HEADER_H,
  });

  // paddingStart reserves the always-rendered meta-column region so the day-column
  // virtualizer only mounts day cells that are actually in the horizontal viewport.
  const colVirtualizer = useVirtualizer({
    horizontal: true,
    count: DAY_COUNT,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => DAY_W,
    overscan: 4,
    paddingStart: META_WIDTH,
  });

  const reparent = useCallback((childId: string, newParentId: string) => {
    setTree((prev) => {
      let moved: Task | null = null;
      const stripped = prev.map((p) => {
        if (!p.subRows) return p;
        const idx = p.subRows.findIndex((c) => c.id === childId);
        if (idx === -1) return p;
        moved = p.subRows[idx];
        return { ...p, subRows: [...p.subRows.slice(0, idx), ...p.subRows.slice(idx + 1)] };
      });
      if (!moved) return prev;
      return stripped.map((p) => (p.id === newParentId ? { ...p, subRows: [...(p.subRows ?? []), moved as Task] } : p));
    });
  }, []);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const onDragStart = useCallback((e: DragStartEvent) => {
    const d = e.active.data.current as DragData | undefined;
    setActiveLabel(d?.label ?? null);
  }, []);

  const onDragEnd = useCallback(
    (e: DragEndEvent) => {
      setActiveLabel(null);
      const src = e.active.data.current as DragData | undefined;
      const tgt = e.over?.data.current as DragData | undefined;
      if (!src || !tgt) return;
      const newParentId = tgt.depth === 0 ? tgt.id : tgt.parentId;
      if (src.depth === 1 && newParentId && newParentId !== src.parentId) {
        reparent(src.id, newParentId);
      }
    },
    [reparent],
  );

  const virtualRows = rowVirtualizer.getVirtualItems();
  const virtualCols = colVirtualizer.getVirtualItems();

  const body = (
    <div ref={setScroller} className="scroller" data-testid="scroller" data-rows={rows.length}>
      <div className="canvas" style={{ width: TOTAL_WIDTH, height: rowVirtualizer.getTotalSize() }}>
        <HeaderRow virtualCols={virtualCols} />
        {virtualRows.map((vr) => {
          const row = rows[vr.index];
          const common = { row, top: vr.start, virtualCols };
          return dndEnabled ? <RowViewDnd key={row.id} {...common} /> : <RowViewPlain key={row.id} {...common} />;
        })}
      </div>
    </div>
  );

  return (
    <div className="grid-wrap">
      <div className="toolbar">
        <strong>TanStack WBS grid spike</strong>
        <span className="stat" data-testid="visible-rows">
          flattened rows: {rows.length}
        </span>
        <span className="stat">columns: {META_COLS.length + DAY_COUNT} ({META_COLS.length} meta + {DAY_COUNT} day)</span>
        <button onClick={() => table.toggleAllRowsExpanded(true)}>全展開</button>
        <button onClick={() => table.toggleAllRowsExpanded(false)}>全折畳</button>
        <label className="dnd-toggle">
          <input type="checkbox" checked={dndEnabled} onChange={(e) => setDndEnabled(e.target.checked)} /> dnd-kit registration
        </label>
      </div>
      {/* DndContext stays mounted so the scroll element never remounts. The dnd
          toggle only swaps the row component (registering draggable/droppable per
          row vs not), which is exactly the per-row overhead we want to A/B. */}
      <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}>
        {body}
        <DragOverlay>{activeLabel ? <div className="drag-overlay">{activeLabel}</div> : null}</DragOverlay>
      </DndContext>
    </div>
  );
}
