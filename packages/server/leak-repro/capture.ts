import { chromium } from "playwright-core";
const EXE = "/projects/.atelier-tools/chromium/chrome-linux64/chrome";
const OUT = "/projects/dash-memory-leak-20260930/shots";
const b = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
// The health page is its own viewport; the list needs a taller one.
const page = await b.newPage({ viewport: { width: 1600, height: 1400 } });
await page.goto("http://127.0.0.1:8791/", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(8000);
await page.waitForTimeout(4000);

// widen the sidebar so the session list is legible in a screenshot
await page.addStyleTag({ content: "[class*=sidebar],[class*=Sidebar]{min-width:520px !important;max-width:520px !important}" });
await page.waitForTimeout(1500);

// open the ended tier, then its "More" expander, so the bounded tombstone
// rows are actually visible rather than behind a disclosure
for (const sel of ["text=/Hide ended/", "text=/^\\d+ ended/"]) {
  const l = page.locator(sel).first();
  if (await l.count()) { try { await l.click({ timeout: 2000 }); await page.waitForTimeout(1200); } catch {} }
}
const more = page.locator("text=More").first();
for (let i = 0; i < 6; i++) {
  if (!(await more.count())) break;
  try { await more.click({ timeout: 1500 }); await page.waitForTimeout(900); } catch { break; }
}
await page.waitForTimeout(2000);
await page.screenshot({ path: `${OUT}/02-ended-tier-bounded.png` });
const nEnded = await page.locator("text=/Hide ended|More/").count();
console.log("CAPTURE2 disclosures=" + nEnded);

// ── second capture: the running server's own /api/health, rendered ──────────
// Read live rather than from the CSV, so the image cannot drift from the
// numbers in artifacts/.
await page.goto("http://127.0.0.1:8791/api/health", { waitUntil: "domcontentloaded" });
const raw = await page.locator("body").innerText();
const d = JSON.parse(raw);
const s = d.droppedFrames.serverToBrowser;
await page.setContent(`<html><body style="font:16px ui-monospace,Menlo,monospace;background:#0f1115;color:#e6e6e6;padding:32px">
<h2 style="color:#8ab4f8;font-size:20px">pi-dashboard — live bounded state, mid-churn</h2>
<pre style="font-size:17px;line-height:1.7">
activeBridgeCount (routing table)  : ${d.activeBridgeCount}
frames shed under back-pressure   : ${s.total}
distinct sessions in bySession     : ${Object.keys(s.bySession).length}   &lt;- capped at 500
</pre>
<p style="color:#9aa0a6">Read from the running server's own /api/health, not copied from the CSV.</p>
</body></html>`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(800);
await page.screenshot({ path: `${OUT}/03-live-bounded-tables.png` });
console.log("CAPTURE3 routes=" + d.activeBridgeCount + " drops=" + s.total + " distinct=" + Object.keys(s.bySession).length);


await b.close();

