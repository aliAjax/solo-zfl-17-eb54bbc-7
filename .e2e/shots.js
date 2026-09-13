const { chromium } = require("@playwright/test");

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
  await page.goto("http://localhost:8717/index.html");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.click('[data-view-tab="repair"]');
  await page.waitForTimeout(300);
  await page.screenshot({ path: "/workspace/.e2e/shots/04-step-gantt.png", fullPage: true });

  // 把 A-030 的复检与 B卷复检 钉到同一放映员同一天 → 非主设备（放映机）冲突
  const idOf = async (code) =>
    page.evaluate(
      (c) =>
        [...document.querySelectorAll(".job-card")].find((x) =>
          x.querySelector(".job-head strong").textContent === c
        )?.querySelector("[data-pick]").dataset.pick,
      code
    );
  const a030 = await idOf("A-030");
  const place = await page.evaluate(
    (job) => {
      const b = document.querySelector(`.gantt-block[data-job="${job}"][data-step="screen"]`);
      const laneIdx = [...document.querySelectorAll("[data-person-lane]")].indexOf(b.closest(".lane"));
      return { person: [...document.querySelectorAll(".lane-name")][laneIdx].querySelector("strong").textContent, day: Number(b.style.gridColumnStart) - 2 };
    },
    a030
  );
  const drag = async (job, stepKey, person, day) =>
    page.evaluate(
      ({ job, stepKey, person, day }) => {
        const block = document.querySelector(`.gantt-block[data-job="${job}"][data-step="${stepKey}"]`);
        const laneName = [...document.querySelectorAll(".lane-name")].find((n) => n.textContent.includes(person));
        const cell = laneName.nextElementSibling.querySelector(`[data-cell-day="${day}"]`);
        const dt = new DataTransfer();
        const fire = (t, ty) => t.dispatchEvent(new DragEvent(ty, { bubbles: true, cancelable: true, dataTransfer: dt }));
        fire(block, "dragstart"); fire(cell, "dragover"); fire(cell, "drop"); fire(block, "dragend");
      },
      { job, stepKey, person: place.person, day: place.day }
    );
  const bJuan = await idOf("B卷");
  await drag(a030, "screen", place.person, place.day); // 先钉住 A-030 复检
  await drag(bJuan, "screen", place.person, place.day);
  await page.waitForTimeout(300);
  await page.screenshot({ path: "/workspace/.e2e/shots/05-step-conflict.png", fullPage: true });
  console.log("SHOTS_DONE", JSON.stringify(place));
  await browser.close();
})();
