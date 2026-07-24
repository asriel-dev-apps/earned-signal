import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  applyProjectCommand,
  type ProjectCommand,
  type ProjectState,
} from "@vecta/application";

// ADR 0012 Step 4c — the master screens' client save pipeline, mirroring 4b's
// `WbsApp` connected mode with the grid removed (masters carry NO derived values,
// so there is no `projectWbsGrid` recompute — the optimistic store is the project
// state alone). It owns: optimistic `applyProjectCommand`, the `saving.current`
// block-during-save, the rollback snapshot on a rejected save, the `role="alert"`
// notice, a per-route confirmed revision (seeded from the loader, advanced on each
// success), and the VERSION_CONFLICT → 409 → revalidate → adopt-from-loader effect
// (no remount). There is NO post-save reload — the sanctioned instant-save delta
// (the SPA's `reload()` + its "could not refresh" string die here by design).
//
// It is deliberately router-free (no `useFetcher`): the route wrapper (`MasterRoute`)
// owns the fetcher + dispatch seam and feeds `onExecute`/`saveInFlight`/`saveResult`
// in, exactly as `ProjectWbs` feeds `WbsApp`. That keeps this component renderable
// in an in-memory test harness with a spy `onExecute` and no router, the same shape
// the 4b connected tests use.
//
// Which panels mount is a render prop (`children`), so the ONE pipeline hosts the
// masters (工程/プロダクト), members, and templates routes without harmonizing the
// panels themselves.

type SaveState = "saved" | "saving" | "error";

/**
 * The action outcome the route derives from its `useFetcher` and feeds back
 * (mirrors `WbsApp`'s `SaveActionResult`). The success `kind` is one of the
 * master self-save discriminants; revisions cross as strings.
 */
export type MasterSaveResult =
  | { readonly ok: true; readonly kind: "masters-save" | "members-save" | "templates-save"; readonly revision: string }
  | { readonly ok: false; readonly code: "VERSION_CONFLICT"; readonly actualRevision: string }
  | { readonly ok: false; readonly code: "FORBIDDEN" }
  | { readonly ok: false; readonly code: "NOT_FOUND" }
  | { readonly ok: false; readonly code: "INVALID"; readonly message?: string };

/** The state the render prop needs to mount + wire its panels. */
export interface MasterRenderContext {
  readonly project: ProjectState;
  readonly editable: boolean;
  readonly executeCommand: (command: ProjectCommand) => boolean;
}

export interface MasterAppProps {
  /** The role-scoped project state view from the route loader (server-rendered). */
  readonly initialState: ProjectState;
  /** The loader's revision; the confirmed revision is seeded from it. */
  readonly initialRevision: string;
  /** The tier-2 `app-header` subtitle (per-route faithful split of the SPA's). */
  readonly subtitle: string;
  /** Dispatch seam: forward the applied command batch with the CONFIRMED revision. */
  readonly onExecute: (commands: readonly ProjectCommand[], expectedRevision: string) => void;
  /** Is a save in flight? The route passes `fetcher.state !== "idle"`. */
  readonly saveInFlight: boolean;
  /** The latest action outcome (`fetcher.data`); processed on the settle edge. */
  readonly saveResult?: MasterSaveResult | undefined;
  /** The panels to mount, given the current project + editability + dispatch. */
  readonly children: (ctx: MasterRenderContext) => ReactNode;
}

export function MasterApp({
  initialState,
  initialRevision,
  subtitle,
  onExecute,
  saveInFlight,
  saveResult,
  children,
}: MasterAppProps) {
  const [project, setProject] = useState<ProjectState>(initialState);
  // Loaded (data seeded from the loader) so the screen starts editable; moves
  // through "saving"/"error" off the fetcher, back to "saved" on success/adopt.
  const [saveState, setSaveState] = useState<SaveState>("saved");
  // The confirmed server revision (ADR 0012 Step 4b obligation 1): seeded from the
  // loader, advanced from each successful action result, reset by the conflict
  // adopt effect. Dispatch passes THIS — not the static `initialRevision` prop —
  // so batch 2+ carries the up-to-date revision (else a spurious VERSION_CONFLICT).
  const [confirmedRevision, setConfirmedRevision] = useState(initialRevision);
  const [notice, setNotice] = useState<string | null>(null);
  // Block-during-save (parity with the SPA + 4b; the queue is 4d): true from
  // dispatch until the fetcher settles, so a concurrent edit is dropped. The
  // pre-optimistic snapshot restores state if the save is rejected.
  const saving = useRef(false);
  const rollbackSnapshot = useRef<ProjectState | null>(null);
  // Tracks the in-flight→settled edge of the fetcher so the outcome is processed
  // exactly once.
  const settleWasInFlight = useRef(false);
  // The loader revision this component has reconciled with. Successful saves skip
  // revalidation (`shouldRevalidate`), so `initialRevision` only changes when a
  // conflict-triggered revalidation delivers fresh loader data — the adopt signal.
  const adoptedLoaderRevision = useRef(initialRevision);

  const editable = saveState === "saved";

  // Optimistic apply → dispatch, mirroring 4b's `executeCommands` but without a
  // derived-column recompute (masters carry no derived values). The
  // `applyProjectCommand` runs first inside a try: a domain rejection (e.g.
  // deleting a 工程 still referenced by a task) becomes a notice + no-op and never
  // reaches the server — exactly the SPA's behaviour.
  const executeCommand = useCallback(
    (command: ProjectCommand): boolean => {
      if (saving.current) return false;
      let candidate: ProjectState;
      try {
        candidate = applyProjectCommand(project, command);
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "The edit could not be applied");
        return false;
      }
      // Snapshot BEFORE mutating so a rejected save restores the pre-optimistic state.
      rollbackSnapshot.current = project;
      saving.current = true;
      settleWasInFlight.current = false;
      setSaveState("saving");
      setProject(candidate);
      setNotice(null);
      onExecute([command], confirmedRevision);
      return true;
    },
    [confirmedRevision, onExecute, project],
  );

  // Process the save outcome on the fetcher's in-flight→settled edge. Block-during-
  // save means at most one dispatch is in flight, so the just-settled `saveResult`
  // is unambiguously its outcome:
  //   • success  → advance the confirmed revision, drop the snapshot, badge "saved".
  //                NO reload/re-settle (the optimistic state is already correct).
  //   • conflict → the fetcher's own revalidation reloads the loader (409 forces
  //                `shouldRevalidate` true); the adopt effect reconciles the fresh
  //                data. Badge "error" (the screen locks until resync).
  //   • else     → roll back state from the snapshot, badge "error", notice.
  useEffect(() => {
    const settled = settleWasInFlight.current && saveInFlight !== true;
    settleWasInFlight.current = saveInFlight === true;
    if (!settled || !saving.current) return;
    saving.current = false;
    const result = saveResult;
    if (result?.ok === true) {
      setConfirmedRevision(result.revision);
      rollbackSnapshot.current = null;
      setSaveState("saved");
      setNotice(null);
    } else if (result?.ok === false && result.code === "VERSION_CONFLICT") {
      // The server is ahead — a true conflict or a partial commit. Both mean the
      // server committed state the client's pre-batch snapshot no longer matches,
      // so we do NOT roll back: the loader-revision effect adopts the fresh state
      // after the forced revalidation.
      rollbackSnapshot.current = null;
      setSaveState("error");
    } else {
      const snapshot = rollbackSnapshot.current;
      if (snapshot !== null) setProject(snapshot);
      rollbackSnapshot.current = null;
      setSaveState("error");
      setNotice(
        result?.ok === false && result.code === "INVALID" && result.message !== undefined
          ? result.message
          : "The edit could not be saved",
      );
    }
  }, [saveInFlight, saveResult]);

  // Conflict resync (replaces the SPA's `reload()`). A successful self-save skips
  // revalidation, so `initialRevision` (the loader value) only changes when a
  // VERSION_CONFLICT triggered a revalidation that delivered fresh data. On that
  // change, ADOPT the fresh state view + revision into component state — no
  // remount (the DOM node persists; focus/selection survive). The badge returns to
  // "saved": the fresh data is shown, the rejected edit is not, and editing resumes.
  useEffect(() => {
    if (initialRevision === adoptedLoaderRevision.current) return;
    // Defer while a save is still in flight: adopting mid-save would clobber the
    // in-flight edit. The outcome effect (declared first, flushed first) clears
    // `saving.current` on the settle edge, so a real conflict resync still adopts.
    if (saving.current) return;
    adoptedLoaderRevision.current = initialRevision;
    // A benign catch-up revalidation (the loader merely caught up to the revision
    // we already confirmed) is NOT a conflict: reconcile the ref, keep state.
    if (initialRevision === confirmedRevision) return;
    setProject(initialState);
    setConfirmedRevision(initialRevision);
    setSaveState("saved");
    setNotice(
      `This project changed elsewhere and was reloaded at revision ${initialRevision}. Your edit was not saved.`,
    );
  }, [initialRevision, initialState, confirmedRevision]);

  return (
    <div className="app-shell master-shell">
      <header className="app-header">
        <p className="app-subtitle">{subtitle}</p>
        <div className={`save-badge save-badge--${saveState}`} data-testid="save-state">{saveState}</div>
      </header>
      {notice !== null && (
        <div className="master-notice" role="alert" data-testid="master-notice">{notice}</div>
      )}
      <div className="master-body" data-testid="master-screen">
        {children({ project, editable, executeCommand })}
      </div>
    </div>
  );
}
