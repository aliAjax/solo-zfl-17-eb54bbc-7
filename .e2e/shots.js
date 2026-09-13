const { chromium } = require("@playwright/test");

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.goto("http://localhost:8717/index.html");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.screenshot({ path: "/workspace/.e2e/shots/01-check-desk.png", fullPage: true });
  await page.click('[data-view-tab="repair"]');
  await page.waitForTimeout(300);
  await page.screenshot({ path: "/workspace/.e2e/shots/02-repair-desk.png", fullPage: true });
  // 制造人员+设备冲突
  await page.evaluate(() => {
    const add = (code, dmg) => {
      document.querySelector("#fSegCode").value = code;
      const cb = document.querySelector(`input[name=fdmg][value=${dmg}]`);
      cb.checked = true;
      document.querySelector("#fSubmit").click();
      cb.checked = false;
    };
    add("XX-1", "scratch");
    add("XX-2", "scratch");
  });
  await page.waitForTimeout(200);
  await page.evaluate((personName) => {
    const blocks = [...document.querySelectorAll(".gantt-block")];
    const find = (code) => blocks.find((b) => b.querySelector("strong").textContent === code);
    const laneName = [...document.querySelectorAll(".lane-name")].find((n) => n.textContent.includes(personName));
    const lane = laneName.nextElementSibling;
    const fire = (t, type, dt) => t.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
    for (const code of ["XX-1", "XX-2"]) {
      const b = [...document.querySelectorAll(".gantt-block")].find((x) => x.querySelector("strong").textContent === code);
      const laneName = [...document.querySelectorAll(".lane-name")].find((n) => n.textContent.includes(personName));
      const cell = laneName.nextElementSibling.querySelector('[data-cell-day="1"]');
      const dt = new DataTransfer();
      fire(b, "dragstart", dt);
      fire(cell, "dragover", dt);
      fire(cell, "drop", dt);
      fire(b, "dragend", dt);
    }
  }, "林修复");
  await page.waitForTimeout(300);
  await page.screenshot({ path: "/workspace/.e2e/shots/03-conflict.png", fullPage: true });
  await browser.close();
  console.log("SHOTS_DONE");
})();
