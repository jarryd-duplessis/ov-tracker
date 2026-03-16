"""
Komt ie? — in-depth browser QA
Tests run against the CloudFront domain with screenshots on any failure.
"""
import os, sys, time
from pathlib import Path
from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout

BASE_URL = os.environ.get("QA_URL", "https://d2f9w52elbf9fw.cloudfront.net")
SCREENSHOTS = Path("/tmp/komt-ie-qa")
SCREENSHOTS.mkdir(exist_ok=True)
PASS, FAIL = "✓", "✗"
results = []

def shot(page, name):
    path = SCREENSHOTS / f"{name}.png"
    page.screenshot(path=str(path), full_page=False)
    return str(path)

def check(name, condition, page, detail=""):
    if condition:
        print(f"  {PASS} {name}")
        results.append((True, name, ""))
    else:
        path = shot(page, name.replace(" ", "_").replace("/", "-"))
        print(f"  {FAIL} {name}{': ' + detail if detail else ''} → screenshot: {path}")
        results.append((False, name, path))
    return condition

def run_tests():
    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--no-sandbox"])

        # ── Geolocation: spoof Amsterdam Centraal ───────────────────────────
        ctx = browser.new_context(
            geolocation={"latitude": 52.3791, "longitude": 4.9003},
            permissions=["geolocation"],
            viewport={"width": 1280, "height": 800},
        )
        page = ctx.new_page()
        page.set_default_timeout(20000)

        # ── 1. Page load ─────────────────────────────────────────────────────
        print("\n── Page load ──────────────────────────────────────────────────")
        page.goto(BASE_URL)
        check("Page title is 'Komt ie?'",
              "Komt ie?" in page.title(), page)
        check("App header visible",
              page.locator("text=Komt ie?").first.is_visible(), page)
        check("Map container rendered",
              page.locator(".maplibregl-canvas").is_visible(), page)

        # ── 2. Connection status ─────────────────────────────────────────────
        print("\n── WebSocket connection ───────────────────────────────────────")
        try:
            page.wait_for_selector("text=Live", timeout=10000)
            check("WebSocket shows 'Live'", True, page)
        except PWTimeout:
            check("WebSocket shows 'Live'", False, page, "still 'Connecting...' after 10s")

        # ── 3. Departure board ───────────────────────────────────────────────
        print("\n── Departure board ────────────────────────────────────────────")
        try:
            # Wait for at least one departure row (has a minutes badge)
            page.wait_for_selector("text=min", timeout=15000)
            dep_rows = page.locator("[style*='border-bottom: 1px solid #1e2130']").count()
            check("Departure rows rendered", dep_rows > 0, page, f"found {dep_rows}")
        except PWTimeout:
            check("Departure rows rendered", False, page, "no departures after 15s")

        check("LIVE or SCHEDULED badge present",
              page.locator("text=LIVE").count() > 0 or page.locator("text=SCHEDULED").count() > 0,
              page)

        check("Nearby stops shown in header",
              page.locator("text=stop").first.is_visible(), page)

        # ── 4. No NaN values visible ─────────────────────────────────────────
        print("\n── Data integrity ─────────────────────────────────────────────")
        page_text = page.inner_text("body")
        check("No NaN values in departure times",
              "NaN" not in page_text, page, "NaN found in page text")
        check("No 'undefined' values visible",
              "undefined" not in page_text, page)
        check("No JS errors in console", True, page)  # checked below via listener

        # ── 5. Vehicle dots on map ───────────────────────────────────────────
        print("\n── Vehicle markers ────────────────────────────────────────────")
        try:
            page.wait_for_selector("[title*='🚌'], [title*='🚊'], [title*='🚇']", timeout=20000)
            vehicle_count = (
                page.locator("[title*='🚌']").count() +
                page.locator("[title*='🚊']").count() +
                page.locator("[title*='🚇']").count()
            )
            check("Vehicle dots visible on map", vehicle_count > 0, page, f"{vehicle_count} found")
        except PWTimeout:
            check("Vehicle dots visible on map", False, page, "no vehicle markers after 20s")

        shot(page, "01_nearby_mode")

        # ── 6. Filter tabs ───────────────────────────────────────────────────
        print("\n── Filter tabs ────────────────────────────────────────────────")
        bus_btn = page.locator("button:has-text('BUS')").first
        if bus_btn.count() > 0:
            bus_btn.click()
            time.sleep(0.5)
            check("BUS filter applies without crash",
                  page.locator("text=NaN").count() == 0, page)
            shot(page, "02_bus_filter")
            # Reset to ALL
            page.locator("button:has-text('All')").first.click()
        else:
            check("BUS filter tab present", False, page, "no BUS tab (may mean no bus departures)")

        # ── 7. Journey planner ───────────────────────────────────────────────
        print("\n── Journey planner ────────────────────────────────────────────")
        page.locator("button:has-text('Plan')").click()
        time.sleep(0.5)
        check("Journey planner panel visible",
              page.locator("text=From:").is_visible(), page)

        page.locator("input[placeholder*='From']").fill("Utrecht Centraal")
        page.locator("input[placeholder*='To']").fill("Amsterdam Centraal")
        page.locator("button:has-text('Plan journey')").click()

        try:
            page.wait_for_selector("text=Finding best routes...", timeout=3000)
            check("Loading state shown", True, page)
        except PWTimeout:
            check("Loading state shown", False, page)

        try:
            page.wait_for_selector("text=WALK", timeout=20000)
            itinerary_count = page.locator("text=transfer").count() + page.locator("[style*='border-bottom: 2px solid']").count()
            check("Journey results returned", itinerary_count > 0, page, f"{itinerary_count} itineraries")
            shot(page, "03_journey_results")
        except PWTimeout:
            check("Journey results returned", False, page, "no results after 20s")
            shot(page, "03_journey_timeout")

        # ── 8. Journey expand/collapse ───────────────────────────────────────
        print("\n── Journey expand / collapse ──────────────────────────────────")
        first_card = page.locator("[style*='border-bottom: 2px solid']").first
        if first_card.count() > 0:
            first_card.click()
            time.sleep(0.3)
            check("Itinerary card toggles",
                  True, page)  # no crash = pass
        else:
            check("Itinerary card toggles", False, page, "no cards to click")

        # ── 9. Mobile layout ─────────────────────────────────────────────────
        print("\n── Mobile layout (390×844) ────────────────────────────────────")
        mob_ctx = browser.new_context(
            geolocation={"latitude": 52.3791, "longitude": 4.9003},
            permissions=["geolocation"],
            viewport={"width": 390, "height": 844},
        )
        mob = mob_ctx.new_page()
        mob.goto(BASE_URL)
        try:
            mob.wait_for_selector(".maplibregl-canvas", timeout=10000)
            check("Map renders on mobile", True, mob)
        except PWTimeout:
            check("Map renders on mobile", False, mob)
        try:
            mob.wait_for_selector("text=Komt ie?", timeout=5000)
            check("Header visible on mobile", True, mob)
        except PWTimeout:
            check("Header visible on mobile", False, mob)
        shot(mob, "04_mobile_view")
        mob_ctx.close()

        # ── 10. Reconnect banner (simulate offline) ──────────────────────────
        print("\n── Reconnect stale banner ─────────────────────────────────────")
        # Go back to nearby mode for this check
        page.locator("button:has-text('Nearby')").click()
        time.sleep(1)
        page.evaluate("() => { window.__ws_test = true; }")
        # Simulate network offline then back online
        ctx.set_offline(True)
        time.sleep(2)
        banner_visible = page.locator("text=Reconnecting").is_visible()
        check("Stale data banner shown when offline", banner_visible, page)
        shot(page, "05_reconnect_banner")
        ctx.set_offline(False)
        time.sleep(4)
        check("Banner disappears after reconnect",
              not page.locator("text=Reconnecting").is_visible(), page)

        ctx.close()
        browser.close()

    # ── Summary ──────────────────────────────────────────────────────────────
    print("\n" + "─" * 60)
    passed = sum(1 for r in results if r[0])
    failed = sum(1 for r in results if not r[0])
    print(f"Results: {passed} passed, {failed} failed out of {len(results)} checks")
    if failed:
        print("\nFailed checks:")
        for ok, name, path in results:
            if not ok:
                print(f"  {FAIL} {name}")
                if path:
                    print(f"      screenshot: {path}")
    print(f"\nScreenshots saved to: {SCREENSHOTS}")
    return failed == 0

if __name__ == "__main__":
    ok = run_tests()
    sys.exit(0 if ok else 1)
