const { test, expect, chromium } = require("@playwright/test");

const BASE = "http://localhost:8717/index.html";

async function freshPage() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(BASE);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  return { browser, page, errors };
}

async function openRepair(page) {
  await page.click('[data-view-tab="repair"]');
  await expect(page.locator("#viewRepair")).toBeVisible();
}

async function jobIdByCode(page, code) {
  return page.evaluate((code) => {
    const card = [...document.querySelectorAll(".job-card")].find((c) =>
      c.querySelector(".job-head strong")?.textContent.trim().startsWith(code)
    );
    return card?.querySelector("[data-pick]")?.dataset.pick || null;
  }, code);
}

async function addJob(page, { code, damage, reel = "first", priority }) {
  if (reel !== "first") await page.selectOption("#fReel", { label: reel });
  await page.fill("#fSegCode", code);
  await page.check(`input[name=fdmg][value=${damage}]`);
  if (priority) await page.selectOption("#fPriority", priority);
  await page.click("#fSubmit");
  await page.uncheck(`input[name=fdmg][value=${damage}]`).catch(() => {});
}

async function editJobDeps(page, code, checks, unchecks = []) {
  const id = await jobIdByCode(page, code);
  await page.click(`.job-card:has([data-pick="${id}"]) [data-edit="${id}"]`);
  for (const depCode of checks) {
    const depId = await jobIdByCode(page, depCode);
    await page.check(`input[name=fdep][value="${depId}"]`);
  }
  for (const depCode of unchecks) {
    const depId = await jobIdByCode(page, depCode);
    await page.uncheck(`input[name=fdep][value="${depId}"]`);
  }
  await page.click("#fSubmit");
}

async function dragBlockToPersonDay(page, blockJobCode, personName, day) {
  await page.evaluate(
    ({ blockJobCode, personName, day }) => {
      const jobId = [...document.querySelectorAll(".job-card")].find((c) =>
        c.querySelector(".job-head strong")?.textContent.trim().startsWith(blockJobCode)
      )?.querySelector("[data-pick]").dataset.pick;
      const block = document.querySelector(`.gantt-block[data-job="${jobId}"]`);
      const laneName = [...document.querySelectorAll(".lane-name")].find((n) => n.textContent.includes(personName));
      const lane = laneName.nextElementSibling;
      const cell = lane.querySelector(`[data-cell-day="${day}"]`);
      const dt = new DataTransfer();
      const fire = (target, type) =>
        target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
      fire(block, "dragstart");
      fire(cell, "dragover");
      fire(cell, "drop");
      fire(block, "dragend");
    },
    { blockJobCode, personName, day }
  );
}

test.describe.serial("离线修复调度台端到端", () => {
  let browser, page, errors;

  test.beforeAll(async () => {
    const ctx = await freshPage();
    browser = ctx.browser;
    page = ctx.page;
    errors = ctx.errors;
  });

  test.afterAll(async () => {
    expect(errors, `页面 JS 报错: ${errors.join(" | ")}`).toEqual([]);
    await browser.close();
  });

  test("回归：原分镜核对台仍可登记、拖拽、统计", async () => {
    await expect(page.locator("#segmentCount")).toHaveText("3");
    await page.fill("#codeInput", "A-099");
    await page.fill("#durationInput", "10");
    await page.click('button[type=submit]', { has: page.locator('text=加入放映清单') });
    await expect(page.locator("#segmentCount")).toHaveText("4");
    await expect(page.locator("#totalDuration")).toHaveText("0:51");
  });

  test("多卷种子数据与指标：两卷10任务、零冲突、可保存", async () => {
    await openRepair(page);
    await expect(page.locator("#rStatJobs")).toHaveText("10");
    await expect(page.locator("#rStatConflicts")).toHaveText("0");
    const makespan = await page.locator("#rStatMakespan").textContent();
    expect(makespan).toMatch(/天$/);
    const risk = Number(await page.locator("#rStatRisk").textContent());
    expect(risk).toBeGreaterThan(0);
    await expect(page.locator("#rSaveBtn")).toBeEnabled();
    await expect(page.locator("#rUndoBtn")).toBeDisabled();
    await expect(page.locator("#rReelFilter option")).toHaveCount(3); // 全部 + 两卷
    await expect(page.locator(".gantt-block").first()).toBeVisible();
  });

  test("多卷：为新胶片卷登记损伤任务，自动排程仍无冲突", async () => {
    await page.selectOption("#fReel", "__new");
    await page.fill("#fNewReel", "纪录片D卷");
    await page.fill("#fSegCode", "D-001");
    await page.check("input[name=fdmg][value=dust]");
    await expect(page.locator("#fRole")).toHaveValue("资料管理员");
    await expect(page.locator("#fHours")).toHaveValue("2");
    await page.click("#fSubmit");
    await expect(page.locator("#rStatJobs")).toHaveText("11");
    await expect(page.locator("#rStatConflicts")).toHaveText("0");
    await expect(page.locator("#rReelFilter")).toContainText("纪录片D卷");
  });

  test("依赖成环：登记互依任务即被门禁拦截，不能保存且不落盘", async () => {
    await addJob(page, { code: "CY-1", damage: "dust" });
    await addJob(page, { code: "CY-2", damage: "dust" });
    await expect(page.locator("#rStatJobs")).toHaveText("13");
    await editJobDeps(page, "CY-2", ["CY-1"]);
    await expect(page.locator("#rStatConflicts")).toHaveText("0");
    await editJobDeps(page, "CY-1", ["CY-2"]);
    await expect(page.locator("#rBlockBanner")).toBeVisible();
    await expect(page.locator("#rConflictList")).toContainText("依赖成环");
    await expect(page.locator("#rStatConflicts")).not.toHaveText("0");
    await expect(page.locator(".tray-card.cycle")).toHaveCount(2);
    await expect(page.locator("#rSaveBtn")).toBeDisabled();
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("zfl17-film-repair-desk-v1")));
    const cy1 = stored.jobs.find((j) => j.code === "CY-1");
    const cy2 = stored.jobs.find((j) => j.code === "CY-2");
    expect(cy1.deps).not.toContain(cy2.id); // 成环版本未落盘
  });

  test("解开环后冲突清零，恢复可保存", async () => {
    await editJobDeps(page, "CY-1", [], ["CY-2"]);
    await expect(page.locator("#rStatConflicts")).toHaveText("0");
    await expect(page.locator("#rSaveBtn")).toBeEnabled();
    await expect(page.locator("#rBlockBanner")).toBeHidden();
  });

  test("资源冲突：拖两个任务到同一人同一天，立即标人员+设备冲突并禁保存", async () => {
    await addJob(page, { code: "RG-1", damage: "scratch" });
    await addJob(page, { code: "RG-2", damage: "scratch" });
    await dragBlockToPersonDay(page, "RG-1", "林修复", 1);
    await page.waitForTimeout(150);
    await dragBlockToPersonDay(page, "RG-2", "林修复", 1);
    await expect(page.locator("#rBlockBanner")).toBeVisible();
    const conflictText = await page.locator("#rConflictList").innerText();
    expect(conflictText).toContain("人员冲突");
    expect(conflictText).toContain("设备冲突");
    const conflicts = Number(await page.locator("#rStatConflicts").textContent());
    expect(conflicts).toBeGreaterThanOrEqual(2);
    await expect(page.locator("#rSaveBtn")).toBeDisabled();
    // 不变量：冲突版本绝不落盘（存储快照由 UI 保证无冲突；下面用刷新验证）
    const storedJobs = await page.evaluate(() => JSON.parse(localStorage.getItem("zfl17-film-repair-desk-v1")).jobs.length);
    expect(storedJobs).toBeGreaterThan(0);
    // 刷新后回到上次干净版本：零冲突、保存可用
    await page.reload();
    await openRepair(page);
    await expect(page.locator("#rStatConflicts")).toHaveText("0");
    await expect(page.locator("#rSaveBtn")).toBeEnabled();
    await expect(page.locator("#rBlockBanner")).toBeHidden();
  });

  test("全自动重排清掉冲突", async () => {
    await page.click("#rAutoBtn");
    await expect(page.locator("#rStatConflicts")).toHaveText("0");
    await expect(page.locator("#rSaveBtn")).toBeEnabled();
  });

  test("批量改优先级：预览影响 → 一次提交 → 刷新保留 → 撤销", async () => {
    const codes = await page.$$eval(".job-card .job-head strong", (els) =>
      els.slice(0, 2).map((e) => e.textContent.trim().split(" ")[0] || e.textContent.trim())
    );
    await page.check(".job-card:nth-child(1) [data-pick]");
    await page.check(".job-card:nth-child(2) [data-pick]");
    await page.selectOption("#bField", "priority");
    await page.selectOption("#bPriority", "高");
    await page.click("#bPreviewBtn");
    const modal = page.locator("#rModalBackdrop");
    await expect(modal).toBeVisible();
    await expect(page.locator("#rModalBody")).toContainText("总工期");
    await expect(page.locator("#rModalBody")).toContainText("风险指数");
    await expect(page.locator("#rModalBody")).toContainText("逐任务改动");
    await page.click("#rModalConfirm");
    await expect(modal).toBeHidden();
    await expect(page.locator("#rStatConflicts")).toHaveText("0");
    await expect(page.locator("#rUndoBtn")).toBeEnabled();
    for (const code of codes) {
      const id = await jobIdByCode(page, code);
      await expect(page.locator(`.job-card:has([data-pick="${id}"]) .pri-tag-高`)).toBeVisible();
    }
    // 刷新保留（提交结果已持久化，撤销栈也持久化）
    await page.reload();
    await openRepair(page);
    for (const code of codes) {
      const id = await jobIdByCode(page, code);
      await expect(page.locator(`.job-card:has([data-pick="${id}"]) .pri-tag-高`)).toBeVisible();
    }
    await expect(page.locator("#rUndoBtn")).toBeEnabled();
    // 撤销上一次提交
    await page.click("#rUndoBtn");
    await expect(page.locator("#rToast")).toContainText("已撤销");
    await page.reload();
    await openRepair(page);
    for (const code of codes) {
      const id = await jobIdByCode(page, code);
      await expect(page.locator(`.job-card:has([data-pick="${id}"]) .pri-tag-高`)).toHaveCount(0);
    }
  });

  test("批量预检失败：空损伤被拒绝，零写入并可关闭", async () => {
    await page.check(".job-card:nth-child(1) [data-pick]");
    await page.selectOption("#bField", "damages");
    const before = await page.locator("#rJobList").innerText();
    await page.click("#bPreviewBtn");
    await expect(page.locator("#rModalTitle")).toContainText("被拒绝");
    await expect(page.locator("#rModalBody")).toContainText("整体回退");
    await expect(page.locator("#rModalConfirm")).toBeDisabled();
    await page.click("#rModalCancel");
    await expect(page.locator("#rModalBackdrop")).toBeHidden();
    const after = await page.locator("#rJobList").innerText();
    expect(after).toBe(before);
  });

  test("批量追加损伤：预览逐任务 before→after，提交后多岗位任务入排，撤销还原", async () => {
    const id1 = await jobIdByCode(page, "D-001");
    const id2 = await jobIdByCode(page, "B-003");
    await page.check(`[data-pick="${id1}"]`);
    await page.check(`[data-pick="${id2}"]`);
    await page.selectOption("#bField", "damages");
    await page.check("input[name=bdmg][value=screen]");
    await page.click("#bPreviewBtn");
    await expect(page.locator("#rModalBody")).toContainText("灰尘霉斑清洁 → 灰尘霉斑清洁、修复后放映复检");
    await page.click("#rModalConfirm");
    for (const id of [id1, id2]) {
      await expect(page.locator(`.job-card:has([data-pick="${id}"]) .tag`).filter({ hasText: "修复后放映复检" })).toBeVisible();
    }
    await expect(page.locator("#rStatConflicts")).toHaveText("0");
    // 撤销该次批量追加
    await page.click("#rUndoBtn");
    for (const id of [id1, id2]) {
      await expect(page.locator(`.job-card:has([data-pick="${id}"]) .tag`).filter({ hasText: "修复后放映复检" })).toHaveCount(0);
    }
  });

  test("开工日期刷新保留", async () => {
    await page.fill("#rStartDate", "2026-09-20");
    await page.dispatchEvent("#rStartDate", "change");
    await expect(page.locator(".gantt-day span").first()).toContainText("09-20");
    await page.reload();
    await openRepair(page);
    await expect(page.locator("#rStartDate")).toHaveValue("2026-09-20");
    await expect(page.locator(".gantt-day span").first()).toContainText("09-20");
  });

  test("班表导出：无冲突 CSV 含表头与排班行", async () => {
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.click("#rExportBtn")
    ]);
    expect(download.suggestedFilename()).toMatch(/^修复班表-.*\.csv$/);
    const path = await download.path();
    const fs = require("fs");
    const csv = fs.readFileSync(path, "utf8");
    expect(csv.startsWith("﻿")).toBe(true); // BOM，Excel 中文不乱码
    expect(csv).toContain("开工日期");
    expect(csv).toContain("春日试映A卷");
    expect(csv).toContain('"林修复","修复师"');
    const lines = csv.trim().split("\n").filter((l) => l && !l.includes("未排程"));
    expect(lines.length).toBeGreaterThan(5);
    expect(csv).not.toContain("⚠ 有冲突");
  });

  test("冲突状态导出的 CSV 带警示段", async () => {
    await dragBlockToPersonDay(page, "RG-1", "林修复", 2);
    await dragBlockToPersonDay(page, "RG-2", "林修复", 2);
    await expect(page.locator("#rStatConflicts")).not.toHaveText("0");
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.click("#rExportBtn")
    ]);
    const path = await download.path();
    const fs = require("fs");
    const csv = fs.readFileSync(path, "utf8");
    expect(csv).toContain("未排程 / 冲突任务");
    expect(csv).toMatch(/人员冲突|设备冲突/);
    await page.click("#rAutoBtn");
    await expect(page.locator("#rStatConflicts")).toHaveText("0");
  });

  test("无空壳入口：资源、设备行、托盘、风险面板均有真实内容", async () => {
    await expect(page.locator("#rPeopleList li")).toHaveCount(5);
    await expect(page.locator("#rEquipList li")).toHaveCount(5);
    await expect(page.locator(".equip-name")).toHaveCount(5);
    await expect(page.locator(".risk-meter")).toBeVisible();
    await expect(page.locator("#rConflictList")).toContainText("无冲突");
  });
});
