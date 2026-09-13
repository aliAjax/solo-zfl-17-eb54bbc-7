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

async function counts(page) {
  return page.evaluate(() => {
    const [jobs, steps] = document.querySelector("#rStatJobs").textContent.match(/\d+/g).map(Number);
    return { jobs, steps };
  });
}

async function jobIdByCode(page, code) {
  return page.evaluate((code) => {
    const card = [...document.querySelectorAll(".job-card")].find((c) =>
      c.querySelector(".job-head strong")?.textContent.trim() === code
    );
    return card?.querySelector("[data-pick]")?.dataset.pick || null;
  }, code);
}

async function addJob(page, { code, damages, reel, priority }) {
  if (reel) await page.selectOption("#fReel", { label: reel });
  await page.fill("#fSegCode", code);
  for (const d of damages) await page.check(`input[name=fdmg][value=${d}]`);
  if (priority) await page.selectOption("#fPriority", priority);
  await page.click("#fSubmit");
  for (const d of damages) await page.uncheck(`input[name=fdmg][value=${d}]`).catch(() => {});
}

async function editJob(page, code, mutate) {
  const id = await jobIdByCode(page, code);
  await page.click(`[data-edit="${id}"]`);
  await mutate();
  await page.click("#fSubmit");
  return id;
}

async function setDeps(page, code, depCodes, uncheckCodes = []) {
  await editJob(page, code, async () => {
    for (const depCode of depCodes) {
      const depId = await jobIdByCode(page, depCode);
      await page.check(`input[name=fdep][value="${depId}"]`);
    }
    for (const depCode of uncheckCodes) {
      const depId = await jobIdByCode(page, depCode);
      await page.uncheck(`input[name=fdep][value="${depId}"]`);
    }
  });
}

async function dragStep(page, code, stepKey, personName, day) {
  await page.evaluate(
    ({ code, stepKey, personName, day }) => {
      const jobId = [...document.querySelectorAll(".job-card")].find((c) =>
        c.querySelector(".job-head strong")?.textContent.trim() === code
      )?.querySelector("[data-pick]").dataset.pick;
      const block =
        document.querySelector(`.gantt-block[data-job="${jobId}"][data-step="${stepKey}"]`) ||
        document.querySelector(`.tray-card[data-job="${jobId}"][data-step="${stepKey}"]`);
      const laneName = [...document.querySelectorAll(".lane-name")].find((n) => n.textContent.includes(personName));
      const cell = laneName.nextElementSibling.querySelector(`[data-cell-day="${day}"]`);
      const dt = new DataTransfer();
      const fire = (t, type) =>
        t.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
      fire(block, "dragstart");
      fire(cell, "dragover");
      fire(cell, "drop");
      fire(block, "dragend");
    },
    { code, stepKey, personName, day }
  );
}

async function stepPlacement(page, code, stepKey) {
  return page.evaluate(
    ({ code, stepKey }) => {
      const jobId = [...document.querySelectorAll(".job-card")].find((c) =>
        c.querySelector(".job-head strong")?.textContent.trim() === code
      )?.querySelector("[data-pick]").dataset.pick;
      const block = document.querySelector(`.gantt-block[data-job="${jobId}"][data-step="${stepKey}"]`);
      if (!block) return null;
      const lane = block.closest(".lane");
      const laneIdx = [...document.querySelectorAll("[data-person-lane]")].indexOf(lane);
      const name = [...document.querySelectorAll(".lane-name")][laneIdx].querySelector("strong").textContent;
      const colStart = Number(block.style.gridColumnStart || block.style.gridColumn.split("/")[0].trim());
      return { person: name, day: colStart - 2 };
    },
    { code, stepKey }
  );
}

async function equipLaneContents(page) {
  return page.evaluate(() => {
    const out = {};
    document.querySelectorAll(".equip-name").forEach((nameEl) => {
      const blocks = nameEl.nextElementSibling.querySelectorAll(".equip-block");
      out[nameEl.querySelector("strong").textContent.replace("设备：", "")] = [...blocks].map((b) =>
        b.querySelector("b") ? `${b.firstChild.textContent.trim()}:${b.querySelector("b").textContent}` : b.textContent.trim()
      );
    });
    return out;
  });
}

test.describe.serial("离线修复调度台端到端（步骤级资源模型）", () => {
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

  test("回归：原分镜核对台登记与统计", async () => {
    await expect(page.locator("#segmentCount")).toHaveText("3");
    await page.fill("#codeInput", "A-099");
    await page.fill("#durationInput", "10");
    await page.click('button[type=submit]', { has: page.locator('text=加入放映清单') });
    await expect(page.locator("#segmentCount")).toHaveText("4");
    await expect(page.locator("#totalDuration")).toHaveText("0:51");
  });

  test("种子：10任务/12工序，两卷，零冲突，混合任务已展开为多步骤", async () => {
    await openRepair(page);
    expect(await counts(page)).toEqual({ jobs: 10, steps: 12 });
    await expect(page.locator("#rStatConflicts")).toHaveText("0");
    await expect(page.locator("#rSaveBtn")).toBeEnabled();
    await expect(page.locator("#rUndoBtn")).toBeDisabled();
    await expect(page.locator("#rReelFilter option")).toHaveCount(3);
    const a030 = await jobIdByCode(page, "A-030");
    await expect(page.locator(`.gantt-block[data-job="${a030}"][data-step="dust"]`)).toBeVisible();
    await expect(page.locator(`.gantt-block[data-job="${a030}"][data-step="screen"]`)).toBeVisible();
  });

  test("混合损伤：清洁步骤占清洁台+管理员，复检步骤占放映机+放映员，两者都入排", async () => {
    const a030 = await jobIdByCode(page, "A-030");
    const dust = await stepPlacement(page, "A-030", "dust");
    const screen = await stepPlacement(page, "A-030", "screen");
    expect(dust).not.toBeNull();
    expect(screen).not.toBeNull();
    expect(["吴档案"]).toContain(dust.person);
    expect(["周放映", "何夜班"]).toContain(screen.person);
    expect(screen.day).toBeGreaterThanOrEqual(dust.day); // 工序顺序
    const lanes = await equipLaneContents(page);
    expect(lanes["清洁台"]).toContainEqual(expect.stringContaining("A-030:清洁"));
    expect(lanes["放映机"]).toContainEqual(expect.stringContaining("A-030:复检"));
    // 任务卡展示两道工序的岗位与设备
    const card = page.locator(`.job-card:has([data-pick="${a030}"])`);
    await expect(card).toContainText("修复后放映复检");
    await expect(card).toContainText("放映机");
    await expect(card).toContainText("清洁台");
  });

  test("非主设备同日冲突：两道复检步骤钉到同一放映员同一天 → 放映机+人员双冲突", async () => {
    await addJob(page, { code: "MX-1", damages: ["dust", "screen"] });
    expect(await counts(page)).toEqual({ jobs: 11, steps: 14 });
    const target = await stepPlacement(page, "A-030", "screen");
    // 先把 A-030 复检钉死在原排程日，再把 MX-1 复检叠到同一人同一天
    await dragStep(page, "A-030", "screen", target.person, target.day);
    await dragStep(page, "MX-1", "screen", target.person, target.day);
    const text = await page.locator("#rConflictList").innerText();
    expect(text).toContain("人员冲突");
    expect(text).toContain("设备冲突");
    expect(text).toContain("放映机");
    expect(text).toContain("A-030");
    expect(text).toContain("MX-1");
    await expect(page.locator("#rSaveBtn")).toBeDisabled();
    await expect(page.locator("#rBlockBanner")).toBeVisible();
    // 冲突版本不落盘：刷新回到零冲突，再全自动重排清掉无冲突的手动钉住
    await page.reload();
    await openRepair(page);
    await expect(page.locator("#rStatConflicts")).toHaveText("0");
    await page.click("#rAutoBtn");
    await expect(page.locator("#rStatConflicts")).toHaveText("0");
  });

  test("修改损伤后重排：给 A-021 追加清洁工序，自动插到资料管理员且零冲突", async () => {
    const id = await editJob(page, "A-021", async () => {
      await page.check("input[name=fdmg][value=dust]");
    });
    const card = page.locator(`.job-card:has([data-pick="${id}"])`);
    await expect(card).toContainText("灰尘霉斑清洁");
    await expect(card).toContainText("清洁");
    const dust = await stepPlacement(page, "A-021", "dust");
    expect(dust).not.toBeNull();
    expect(dust.person).toBe("吴档案");
    const color = await stepPlacement(page, "A-021", "color");
    expect(color.day).toBeGreaterThanOrEqual(dust.day);
    await expect(page.locator("#rStatConflicts")).toHaveText("0");
  });

  test("多卷：为新胶片卷登记任务，自动排程无冲突", async () => {
    await page.selectOption("#fReel", "__new");
    await page.fill("#fNewReel", "纪录片D卷");
    await page.fill("#fSegCode", "D-001");
    await page.check("input[name=fdmg][value=dust]");
    await expect(page.locator("#fHours")).toHaveValue("2");
    await page.click("#fSubmit");
    expect(await counts(page)).toEqual({ jobs: 12, steps: 16 });
    await expect(page.locator("#rStatConflicts")).toHaveText("0");
  });

  test("依赖成环：互依任务全部工序进托盘、门禁拦截且不落盘", async () => {
    await addJob(page, { code: "CY-1", damages: ["dust"] });
    await addJob(page, { code: "CY-2", damages: ["dust"] });
    await setDeps(page, "CY-2", ["CY-1"]);
    await expect(page.locator("#rStatConflicts")).toHaveText("0");
    await setDeps(page, "CY-1", ["CY-2"]);
    await expect(page.locator("#rBlockBanner")).toBeVisible();
    await expect(page.locator("#rConflictList")).toContainText("依赖成环");
    await expect(page.locator(".tray-card.cycle")).toHaveCount(2);
    await expect(page.locator("#rSaveBtn")).toBeDisabled();
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("zfl17-film-repair-desk-v2")));
    const cy1 = stored.jobs.find((j) => j.code === "CY-1");
    const cy2 = stored.jobs.find((j) => j.code === "CY-2");
    expect(cy1.deps).not.toContain(cy2.id);
  });

  test("解开环后冲突清零", async () => {
    await setDeps(page, "CY-1", [], ["CY-2"]);
    await expect(page.locator("#rStatConflicts")).toHaveText("0");
    await expect(page.locator("#rSaveBtn")).toBeEnabled();
  });

  test("主设备资源冲突：两道打磨工序拖给同一修复师同一天 → 人员+抛光机冲突", async () => {
    await addJob(page, { code: "RG-1", damages: ["scratch"] });
    await addJob(page, { code: "RG-2", damages: ["scratch"] });
    await dragStep(page, "RG-1", "scratch", "林修复", 1);
    await dragStep(page, "RG-2", "scratch", "林修复", 1);
    const text = await page.locator("#rConflictList").innerText();
    expect(text).toContain("人员冲突");
    expect(text).toContain("设备冲突");
    expect(text).toContain("抛光机");
    await expect(page.locator("#rSaveBtn")).toBeDisabled();
    await page.reload();
    await openRepair(page);
    await expect(page.locator("#rStatConflicts")).toHaveText("0");
  });

  test("全自动重排清掉手动冲突", async () => {
    await dragStep(page, "RG-1", "scratch", "林修复", 1);
    await dragStep(page, "RG-2", "scratch", "林修复", 1);
    await expect(page.locator("#rSaveBtn")).toBeDisabled();
    await page.click("#rAutoBtn");
    await expect(page.locator("#rStatConflicts")).toHaveText("0");
    await expect(page.locator("#rSaveBtn")).toBeEnabled();
  });

  test("批量改优先级：预览→提交→刷新保留→撤销", async () => {
    const codes = ["A-006", "A-021"];
    for (const code of codes) await page.check(`[data-pick="${await jobIdByCode(page, code)}"]`);
    await page.selectOption("#bField", "priority");
    await page.selectOption("#bPriority", "高");
    await page.click("#bPreviewBtn");
    await expect(page.locator("#rModalBody")).toContainText("冲突工序数");
    await expect(page.locator("#rModalBody")).toContainText("逐任务改动");
    await page.click("#rModalConfirm");
    await expect(page.locator("#rStatConflicts")).toHaveText("0");
    await expect(page.locator("#rUndoBtn")).toBeEnabled();
    for (const code of codes) {
      const id = await jobIdByCode(page, code);
      await expect(page.locator(`.job-card:has([data-pick="${id}"]) .pri-tag-高`)).toBeVisible();
    }
    await page.reload();
    await openRepair(page);
    for (const code of codes) {
      const id = await jobIdByCode(page, code);
      await expect(page.locator(`.job-card:has([data-pick="${id}"]) .pri-tag-高`)).toBeVisible();
    }
    await page.click("#rUndoBtn");
    await page.reload();
    await openRepair(page);
    for (const code of codes) {
      const id = await jobIdByCode(page, code);
      await expect(page.locator(`.job-card:has([data-pick="${id}"]) .pri-tag-高`)).toHaveCount(0);
    }
  });

  test("批量预检失败：空损伤被整体拒绝，零写入", async () => {
    await page.check(`[data-pick="${await jobIdByCode(page, "D-001")}"]`);
    await page.selectOption("#bField", "damages");
    const before = await page.locator("#rJobList").innerText();
    await page.click("#bPreviewBtn");
    await expect(page.locator("#rModalTitle")).toContainText("被拒绝");
    await expect(page.locator("#rModalBody")).toContainText("整体回退");
    await expect(page.locator("#rModalConfirm")).toBeDisabled();
    await page.click("#rModalCancel");
    expect(await page.locator("#rJobList").innerText()).toBe(before);
  });

  test("批量追加损伤：两个清洁任务追加复检，放映机/放映员各多一道工序，撤销后消失", async () => {
    const id1 = await jobIdByCode(page, "D-001");
    const id2 = await jobIdByCode(page, "B-003");
    await page.check(`[data-pick="${id1}"]`);
    await page.check(`[data-pick="${id2}"]`);
    await page.check("input[name=bdmg][value=screen]");
    await page.click("#bPreviewBtn");
    await expect(page.locator("#rModalBody")).toContainText("灰尘霉斑清洁 → 灰尘霉斑清洁、修复后放映复检");
    await page.click("#rModalConfirm");
    await expect(page.locator("#rStatConflicts")).toHaveText("0");
    for (const code of ["D-001", "B-003"]) {
      const place = await stepPlacement(page, code, "screen");
      expect(place).not.toBeNull();
      expect(["周放映", "何夜班"]).toContain(place.person);
    }
    const lanes = await equipLaneContents(page);
    expect(lanes["放映机"].some((x) => x.startsWith("D-001:"))).toBe(true);
    expect(lanes["放映机"].some((x) => x.startsWith("B-003:"))).toBe(true);
    // 撤销：新增工序连同其排程一并还原
    await page.click("#rUndoBtn");
    await expect(page.locator(`.gantt-block[data-job="${id1}"][data-step="screen"]`)).toHaveCount(0);
    await expect(page.locator(`.gantt-block[data-job="${id2}"][data-step="screen"]`)).toHaveCount(0);
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

  test("班表 CSV：按工序导出，混合任务两行设备齐全，跨天工序按天展开", async () => {
    const [download] = await Promise.all([page.waitForEvent("download"), page.click("#rExportBtn")]);
    expect(download.suggestedFilename()).toMatch(/^修复班表-.*\.csv$/);
    const csv = require("fs").readFileSync(await download.path(), "utf8");
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv).toContain("工序");
    expect(csv).toContain("修复后放映复检");
    expect(csv).toContain("放映机");
    expect(csv).toContain('"A-030"');
    const aRows = csv.split("\n").filter((l) => l.includes('"A-030"'));
    expect(aRows.some((l) => l.includes("灰尘霉斑清洁") && l.includes("清洁台"))).toBe(true);
    expect(aRows.some((l) => l.includes("修复后放映复检") && l.includes("放映机"))).toBe(true);
    expect(csv).not.toContain("⚠ 有冲突");
    expect(csv.split("\n").filter((l) => l.startsWith('"2026-')).length).toBeGreaterThan(10);
  });

  test("冲突状态 CSV 带未排程/冲突工序警示段", async () => {
    await dragStep(page, "RG-1", "scratch", "林修复", 2);
    await dragStep(page, "RG-2", "scratch", "林修复", 2);
    await expect(page.locator("#rStatConflicts")).not.toHaveText("0");
    const [download] = await Promise.all([page.waitForEvent("download"), page.click("#rExportBtn")]);
    const csv = require("fs").readFileSync(await download.path(), "utf8");
    expect(csv).toContain("未排程 / 冲突工序");
    expect(csv).toMatch(/人员冲突|设备冲突/);
    await page.click("#rAutoBtn");
    await expect(page.locator("#rStatConflicts")).toHaveText("0");
  });

  test("无空壳入口：人员、设备行、托盘、风险面板均有真实内容", async () => {
    await expect(page.locator("#rPeopleList li")).toHaveCount(5);
    await expect(page.locator("#rEquipList li")).toHaveCount(5);
    await expect(page.locator(".equip-name")).toHaveCount(5);
    await expect(page.locator(".risk-meter")).toBeVisible();
    await expect(page.locator("#rConflictList")).toContainText("无冲突");
    // 甘特里同时能看到三种岗位泳道与全部五台设备的占用块
    await expect(page.locator(".gantt-block").count()).resolves.toBeGreaterThanOrEqual(12);
  });
});
