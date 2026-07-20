"""Playwright acceptance harness for the TanStack WBS grid spike.

Usage: python drive.py <url> <label>
Drives an already-running server, captures node counts, scroll timing (vertical +
horizontal, dnd ON vs OFF), an idle rAF baseline (to expose the headless rAF
cadence floor), sticky/pinned offset proofs, expand/collapse, and a real
pointer-drag re-parent with a programmatic move assertion.
Writes artifacts/<label>-*.png and artifacts/perf_<label>.json.
"""

import json
import os
import sys
from playwright.sync_api import sync_playwright

ART = os.path.join(os.path.dirname(os.path.abspath(__file__)), "artifacts")

LAYOUT_JS = """() => [...document.querySelectorAll('[data-row]')].map(r => ({
    label: (r.querySelector('.task-label')?.textContent) || '',
    depth: r.className.includes('child') ? 1 : 0,
    top: parseFloat(r.style.top),
  })).sort((a,b)=>a.top-b.top)"""

IDLE_JS = """async (n) => {
  const frames=[]; let last=performance.now();
  await new Promise(res=>{let i=0;function t(now){frames.push(now-last);last=now;i++;
    if(i<=n) requestAnimationFrame(t); else res();} requestAnimationFrame(t);});
  frames.shift();
  const s=[...frames].sort((a,b)=>a-b);
  return {n:frames.length,
          avg:+(frames.reduce((a,b)=>a+b,0)/frames.length).toFixed(2),
          worst:+Math.max(...frames).toFixed(2),
          median:+s[Math.floor(s.length/2)].toFixed(2)};
}"""


def main(url, label):
    report = {"url": url, "label": label}

    def shot(page, name):
        page.screenshot(path=os.path.join(ART, f"{label}-{name}"))

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1280, "height": 860})
        errors = []
        page.on("console", lambda m: m.type == "error" and errors.append(m.text))
        page.on("pageerror", lambda e: errors.append(str(e)))

        page.goto(url, wait_until="networkidle")
        page.wait_for_selector("[data-row]")
        page.wait_for_timeout(400)

        scroller = page.locator("[data-testid=scroller]")
        sbox = scroller.bounding_box()

        report["dataRows"] = int(scroller.get_attribute("data-rows"))
        report["nodesInitial"] = page.evaluate("() => window.__perf.countNodes()")
        report["idleBaseline"] = page.evaluate(IDLE_JS, 60)
        shot(page, "01-initial.png")

        # vertical scroll, dnd ON
        report["scroll_y_dndON"] = page.evaluate(
            "async () => await window.__perf.runScroll({axis:'y', steps:120})")
        hbox = page.locator(".header").first.bounding_box()
        report["headerStickyOffsetPx"] = round(hbox["y"] - sbox["y"], 1)
        shot(page, "02-scrolled-bottom.png")

        # horizontal scroll, dnd ON
        report["scroll_x_dndON"] = page.evaluate(
            "async () => await window.__perf.runScroll({axis:'x', steps:120})")
        pbox = page.locator(".row-pinned").first.bounding_box()
        report["pinnedStickyOffsetPx"] = round(pbox["x"] - sbox["x"], 1)
        shot(page, "03-scrolled-right.png")

        page.evaluate("() => window.__grid.scroller.scrollTo(0,0)")
        page.wait_for_timeout(150)

        # A/B: dnd registration OFF
        page.locator(".dnd-toggle input").uncheck()
        page.wait_for_timeout(200)
        report["nodesDndOff"] = page.evaluate("() => window.__perf.countNodes()")
        report["scroll_y_dndOFF"] = page.evaluate(
            "async () => await window.__perf.runScroll({axis:'y', steps:120})")
        page.evaluate("() => window.__grid.scroller.scrollTo(0,0)")
        page.wait_for_timeout(120)
        report["scroll_x_dndOFF"] = page.evaluate(
            "async () => await window.__perf.runScroll({axis:'x', steps:120})")
        page.evaluate("() => window.__grid.scroller.scrollTo(0,0)")
        page.locator(".dnd-toggle input").check()
        page.wait_for_timeout(250)

        # expand / collapse
        report["rowsBeforeCollapse"] = int(scroller.get_attribute("data-rows"))
        shot(page, "04-expand-before.png")
        page.locator(".row.parent .toggle").first.click()
        page.wait_for_timeout(250)
        report["rowsAfterCollapse"] = int(scroller.get_attribute("data-rows"))
        shot(page, "05-collapse-after.png")
        page.locator(".row.parent .toggle").first.click()
        page.wait_for_timeout(250)

        # drag re-parent (real pointer drag through dnd-kit)
        page.evaluate("() => window.__grid.scroller.scrollTo(0,0)")
        page.wait_for_timeout(150)
        before = page.evaluate(LAYOUT_JS)
        moved_label = next(r["label"] for r in before if r["depth"] == 1)
        p2_label = next(r["label"] for r in before
                        if r["depth"] == 0 and r["label"] != before[0]["label"])
        report["drag"] = {"movedLabel": moved_label, "newParentLabel": p2_label,
                          "oldParentLabel": before[0]["label"]}
        shot(page, "06-drag-before.png")

        child_lbl = page.locator(".row.child .task-label").first.bounding_box()
        p2_row = page.locator(".row.parent").nth(1).bounding_box()
        sx = child_lbl["x"] + min(20, child_lbl["width"] / 2)
        sy = child_lbl["y"] + child_lbl["height"] / 2
        page.mouse.move(sx, sy)
        page.mouse.down()
        page.mouse.move(sx + 10, sy + 6, steps=3)
        page.mouse.move(p2_row["x"] + 40, p2_row["y"] + p2_row["height"] / 2, steps=15)
        page.wait_for_timeout(150)
        page.mouse.up()
        page.wait_for_timeout(350)

        after = page.evaluate(LAYOUT_JS)

        def idx(seq, lbl):
            return next((i for i, r in enumerate(seq) if r["label"] == lbl), -1)

        mi, pi = idx(after, moved_label), idx(after, p2_label)
        moved_row = next((r for r in after if r["label"] == moved_label), None)
        report["drag"].update({
            "afterMovedIndex": mi,
            "afterNewParentIndex": pi,
            "movedIsAfterNewParent": mi > pi >= 0,
            "movedStillChildDepth": bool(moved_row and moved_row["depth"] == 1),
        })
        report["dataRowsAfterDrag"] = int(scroller.get_attribute("data-rows"))
        shot(page, "07-drag-after.png")

        report["consoleErrors"] = errors
        browser.close()

    with open(os.path.join(ART, f"perf_{label}.json"), "w") as f:
        json.dump(report, f, indent=2, ensure_ascii=False)

    def s(k):
        r = report[k]
        return (f"{k}: worstFrame={r['worstFrameMs']} p95={r['p95FrameMs']} "
                f"avg={r['avgFrameMs']} worstLongTask={r['worstLongTaskMs']} "
                f"nLongTask={r['longTaskCount']} totalLongTask={r['totalLongTaskMs']} "
                f"cellsAfter={r['nodesAfter']['cells']} reached={r['finalScroll']}/{r['maxScroll']}")

    print(f"\n===== {label} ({url}) =====")
    print("dataRows:", report["dataRows"], "| nodesInitial:", report["nodesInitial"])
    print("idleBaseline(rAF floor):", report["idleBaseline"])
    print(s("scroll_y_dndON"))
    print(s("scroll_x_dndON"))
    print(s("scroll_y_dndOFF"))
    print(s("scroll_x_dndOFF"))
    print("headerStickyOffsetPx:", report["headerStickyOffsetPx"],
          "| pinnedStickyOffsetPx:", report["pinnedStickyOffsetPx"])
    print("collapse rows:", report["rowsBeforeCollapse"], "->", report["rowsAfterCollapse"])
    print("drag:", report["drag"])
    print("dataRowsAfterDrag:", report["dataRowsAfterDrag"], "| consoleErrors:", errors)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
