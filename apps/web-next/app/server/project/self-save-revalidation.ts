import type { ShouldRevalidateFunctionArgs } from "react-router";

/**
 * ADR 0012 Step 4b — revalidation economy AND conflict recovery for the WBS write
 * path.
 *
 * Every cell commit is a command = one action POST, and React Router revalidates
 * every active loader after every action by default (here: the workspace read on
 * the wbs route AND the project-row read on the `/projects/:id` layout — a full
 * re-read per keystroke-commit). The optimistic pipeline already advanced the
 * client state, so a SUCCESSFUL self-save needs no re-read (the ADR's
 * no-re-settle win; component `useState` survives revalidation). This predicate
 * therefore returns `false` for our own successful wbs save.
 *
 * The recovery cases must FORCE a re-run. RR 8.2.0 defaults `shouldRevalidate` to
 * `false` for any action result with `status >= 400` (router.js: `shouldSkip-
 * Revalidation = actionStatus && actionStatus >= 400`), and our conflict result is
 * `data(..., { status: 409 })`. Returning `defaultShouldRevalidate` there would
 * yield `false` → the wbs loader never re-runs → the adopt effect never fires →
 * the rejected optimistic edit stays on screen forever (a silent divergence). So a
 * result that requires resync (`VERSION_CONFLICT`, which also carries the P1-2
 * partial-commit case) returns `true` explicitly: the route's `shouldRevalidate`
 * is still consulted when the default is `false` (router.js `shouldRevalidateLoader`
 * calls the route predicate first), and returning `true` forces the re-run.
 *
 * The success case is keyed on the `kind: "wbs-save"` discriminant, not a bare
 * `ok === true`, so a future sibling action returning its own `{ ok: true }` on an
 * active ancestor can never suppress the wbs loader's revalidation.
 *
 * `actionResult` (the action's returned payload) is the RR 8.2.0 field; it is
 * present on every active route's `shouldRevalidate` after a fetcher submission.
 * Shared verbatim by the wbs route and every active ancestor, so one per-cell save
 * never fans out into a workspace + project-row reload.
 */
export function skipRevalidationOnSelfSave({
  actionResult,
  defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs): boolean {
  if (actionResult !== null && typeof actionResult === "object") {
    const result = actionResult as { ok?: unknown; kind?: unknown; code?: unknown };
    // Our own successful wbs save — the optimistic state is already correct, so
    // skip the re-settle. Keyed on the discriminant, never a bare `{ ok: true }`.
    if (result.ok === true && result.kind === "wbs-save") {
      return false;
    }
    // A conflict / partial-commit REQUIRES resync: force the loader to re-run so
    // the client can adopt the fresh state view + revision (overriding RR's
    // status>=400 default of `false`).
    if (result.ok === false && result.code === "VERSION_CONFLICT") {
      return true;
    }
  }
  return defaultShouldRevalidate;
}
