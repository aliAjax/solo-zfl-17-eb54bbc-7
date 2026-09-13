const { test, expect, chromium } = require("@playwright/test");

const BASE = "http://localhost:8717/index.html";
const V2 = "zfl17-film-repair-desk-v2";
const V1 = "zfl17-film-repair-desk-v1";

async function launch() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(BASE);
  return { browser, page, errors };
}
async function openRepair(page) {
  await page.click('[data-view-tab="repair"]');
  await expect(page.locator("#viewRepair")).toBeVisible();
}
async function setStore(page, key, value) {
  await page.evaluate(
    ([k, v]) => {
      localStorage.setItem(k, v);
    },
    [key, value]
  );
}
async function readV2(page) {
  return page.evaluate((k) => JSON.parse(localStorage.getItem(k)), V2);
}
async function jobIdByCode(page, code) {
  return page.evaluate((code) => {
    const card = [...document.querySelectorAll(".job-card")].find((c) =>
      c.querySelector(".job-head strong")?.textContent.trim() === code
    );
    return card?.querySelector("[data-pick]")?.dataset.pick || null;
  }, code);
}

/* 一份结构有效、可零冲突排程的 v1 数据（旧任务级排程字段不应被沿用） */
function v1Payload() {
  return {
    startDate: "2026-08-01",
    reels: [{ id: "r-old1", name: "老库房甲卷" }],
    people: [
      { id: "p1", name: "老赵", role: "资料管理员", shift: "早班" },
      { id: "p2", name: "老钱", role: "修复师", shift: "早班" },
      { id: "p3", name: "老孙", role: "放映员", shift: "晚班" },
      { id: "p4", name: "老李", role: "资料管理员", shift: "晚班" }
    ],
    equipment: [
      { id: "e1", name: "清洁台" },
      { id: "e2", name: "抛光机" },
      { id: "e3", name: "放映机" }
    ],
    jobs: [
      // 旧模型：单损伤 + 任务级 assigneeId/startDay（迁移后必须重排）
      { id: "j1", reelId: "r-old1", code: "OLD-1", damage: "dust", priority: "高", note: "旧库注释", deps: [], assigneeId: "p4", startDay: 9, pinned: true },
      { id: "j2", reelId: "r-old1", code: "OLD-2", damage: "scratch", priority: "中", note: "", deps: ["j1"], assigneeId: "p4", startDay: 9, pinned: true },
      { id: "j3", reelId: "r-old1", code: "OLD-3", damage: "screen", priority: "高", note: "", deps: ["j2"], assigneeId: "p3", startDay: 9, pinned: true },
      // 多损伤旧任务：v1 时只按主损伤排，迁移后应展开成 dust+screen 两道工序
      { id: "j4", reelId: "r-old1", code: "OLD-4", damages: ["dust", "screen"], priority: "中", note: "混合", deps: [], assigneeId: null, startDay: null }
    ],
    undo: []
  };
}

test.describe.serial("存储迁移与数据消毒", () => {
  let browser, page, errors;
  test.beforeAll(async () => {
    const ctx = await launch();
    browser = ctx.browser;
    page = ctx.page;
    errors = ctx.errors;
  });
  test.afterAll(async () => {
    expect(errors, `JS 报错: ${errors.join(" | ")}`).toEqual([]);
    await browser.close();
  });

  test("空库：装入种子数据并立即落统一键，无提示条", async () => {
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await openRepair(page);
    expect((await readV2(page)).jobs.length).toBeGreaterThan(0);
    await expect(page.locator("#rLoadNotices")).toBeHidden();
    await expect(page.locator("#rStatConflicts")).toHaveText("0");
  });

  test("旧 v1 有效数据：迁移后卷/人/设备/任务正确显示，旧排程作废重排且零冲突", async () => {
    await setStore(page, V1, JSON.stringify(v1Payload()));
    await page.evaluate((k) => localStorage.removeItem(k), V2);
    await page.reload();
    await openRepair(page);

    // 提示条说明已迁移
    await expect(page.locator("#rLoadNotices")).toContainText("已从旧版本迁移 4 项任务");

    // 卷、人员、设备
    await expect(page.locator("#rReelFilter")).toContainText("老库房甲卷");
    const people = await page.locator("#rPeopleList li").allInnerTexts();
    expect(people.join("|")).toContain("老赵");
    expect(await page.locator("#rPeopleList li")).toHaveCount(4);
    expect(await page.locator("#rEquipList li")).toHaveCount(3);

    // 4 任务、5 道工序（OLD-4 展开成清洁+复检）
    await expect(page.locator("#rStatJobs")).toContainText("4 项");
    await expect(page.locator("#rStatJobs")).toContainText("5 道工序");
    await expect(page.locator("#rStatConflicts")).toHaveText("0");

    // 旧排程（p4@d9 且 p4 是管理员却扛打磨）未沿用：scratch 步骤在修复师泳道
    const j2 = await jobIdByCode(page, "OLD-2");
    const scratch = page.locator(`.gantt-block[data-job="${j2}"][data-step="scratch"]`);
    await expect(scratch).toBeVisible();
    const owner = await scratch.evaluate((el) => {
      const laneIdx = [...document.querySelectorAll("[data-person-lane]")].indexOf(el.closest(".lane"));
      return [...document.querySelectorAll(".lane-name")][laneIdx].querySelector("strong").textContent;
    });
    expect(owner).toBe("老钱");
    expect(Number(scratch.firstChild === null)).toBe(0);
    const colStart = await scratch.evaluate((el) => Number(el.style.gridColumnStart) - 2);
    expect(colStart).not.toBe(9);

    // 混合任务的两道工序都入排，且分到不同岗位
    const j4 = await jobIdByCode(page, "OLD-4");
    await expect(page.locator(`.gantt-block[data-job="${j4}"][data-step="dust"]`)).toBeVisible();
    await expect(page.locator(`.gantt-block[data-job="${j4}"][data-step="screen"]`)).toBeVisible();
    const eqLanes = await page.evaluate(() => {
      const out = {};
      document.querySelectorAll(".equip-name").forEach((n) => {
        out[n.textContent] = [...n.nextElementSibling.querySelectorAll(".equip-block")].map((b) => b.firstChild.textContent.trim());
      });
      return out;
    });
    expect(Object.values(eqLanes).flat()).toContain("OLD-4");
  });

  test("迁移后统一键已有消毒数据，刷新不丢，无需再迁移（无提示条）", async () => {
    const v2 = await readV2(page);
    expect(v2.reels.map((r) => r.name)).toContain("老库房甲卷");
    expect(v2.people.length).toBe(4);
    expect(v2.jobs.find((j) => j.code === "OLD-4").damages.sort()).toEqual(["dust", "screen"]);
    await page.reload();
    await openRepair(page);
    await expect(page.locator("#rLoadNotices")).toBeHidden();
    await expect(page.locator("#rStatJobs")).toContainText("4 项");
    expect((await readV2(page)).people.length).toBe(4);
  });

  test("迁移后修改、刷新保留（统一状态保存）", async () => {
    await page.fill("#fSegCode", "NEW-M");
    await page.check("input[name=fdmg][value=dust]");
    await page.click("#fSubmit");
    await expect(page.locator("#rStatJobs")).toContainText("5 项");
    await page.reload();
    await openRepair(page);
    await expect(page.locator("#rStatJobs")).toContainText("5 项");
    const j = await jobIdByCode(page, "NEW-M");
    expect(j).toBeTruthy();
  });

  test("迁移后批量事务、撤销、导出正常", async () => {
    const j1 = await jobIdByCode(page, "OLD-1");
    await page.check(`[data-pick="${j1}"]`);
    await page.selectOption("#bField", "priority");
    await page.selectOption("#bPriority", "高");
    await page.click("#bPreviewBtn");
    await expect(page.locator("#rModalBody")).toContainText("逐任务改动");
    await page.click("#rModalConfirm");
    await expect(page.locator("#rStatConflicts")).toHaveText("0");
    await page.click("#rUndoBtn");
    await expect(page.locator("#rToast")).toContainText("已撤销");
    const [download] = await Promise.all([page.waitForEvent("download"), page.click("#rExportBtn")]);
    const csv = require("fs").readFileSync(await download.path(), "utf8");
    expect(csv).toContain("老库房甲卷");
    expect(csv).toContain("修复后放映复检");
  });

  test("v2 损坏（非法 JSON）：回退迁移 v1，有效数据不丢", async () => {
    await setStore(page, V1, JSON.stringify(v1Payload()));
    await setStore(page, V2, "{ this is not json ");
    await page.reload();
    await openRepair(page);
    await expect(page.locator("#rLoadNotices")).toContainText("已损坏");
    await expect(page.locator("#rReelFilter")).toContainText("老库房甲卷");
    await expect(page.locator("#rStatJobs")).toContainText("4 项");
    // 恢复后已重写合法 v2
    const raw = await page.evaluate((k) => localStorage.getItem(k), V2);
    expect(() => JSON.parse(raw)).not.toThrow();
    await expect(page.locator("#rStatConflicts")).toHaveText("0");
  });

  test("v2 结构损坏 + v1 也损坏：不覆盖、不崩溃，退回种子并提示", async () => {
    await setStore(page, V2, "42");
    await setStore(page, V1, "not-json-at-all");
    await page.reload();
    await openRepair(page);
    await expect(page.locator("#rLoadNotices")).toContainText("已损坏");
    // 种子默认数据
    await expect(page.locator("#rStatJobs")).toContainText("10 项");
    await expect(page.locator("#rReelFilter")).toContainText("春日试映A卷");
    expect((await readV2(page)).reels.map((r) => r.name)).toContain("春日试映A卷");
  });

  test("部分字段垃圾：未知值补默认、坏条目跳过、幽灵依赖与重复 ID 被消毒", async () => {
    const dirty = {
      startDate: "not-a-date",
      reels: [{ id: "r1", name: "脏数据卷" }, "not-an-object", null],
      people: [
        { id: "pp1", name: "坏岗位甲", role: "火星岗位", shift: "通宵班" },
        { name: "无ID人员", role: "修复师", shift: "早班" }
      ],
      equipment: [{ id: "ee1", name: null }, { name: "接片台" }],
      jobs: [
        { id: "jj1", reelId: "r1", code: "OK-1", damages: ["dust"], priority: "特急", deps: ["ghost-id"], note: 99 },
        { id: "jj2", reelId: "r1", code: "OK-2", damages: ["unknown_damage"], deps: [] }, // 无已知损伤 → 丢弃
        { id: "jj3", reelId: "missing-reel", code: "OK-3", damages: ["screen"], deps: ["jj1", "jj1", "jj3"] },
        { id: "jj1", reelId: "r1", code: "DUP-ID", damages: ["splice"], deps: [] } // 重复 id → 重发
      ],
      undo: [{ label: "坏撤销", jobs: null }, { label: "好撤销", jobs: [{ id: "u1", reelId: "r1", code: "U-1", damages: ["dust"], deps: [] }] }]
    };
    await setStore(page, V2, JSON.stringify(dirty));
    await page.evaluate((k) => localStorage.removeItem(k), V1);
    await page.reload();
    await openRepair(page);

    await expect(page.locator("#rReelFilter")).toContainText("脏数据卷");
    await expect(page.locator("#rStatJobs")).toContainText("3 项"); // 未知损伤任务被丢
    // 未知岗位/班次回退默认，数字姓名转字符串
    const card1 = await jobIdByCode(page, "OK-1");
    expect(card1).toBeTruthy();
    const v2 = await readV2(page);
    const ok1 = v2.jobs.find((j) => j.code === "OK-1");
    expect(ok1.deps).toEqual([]); // 幽灵依赖清除
    expect(ok1.note).toBe("99");
    expect(/^\d{4}-\d{2}-\d{2}$/.test(v2.startDate)).toBe(true); // 坏日期补今天
    const badPerson = v2.people.find((p) => p.name === "坏岗位甲");
    expect(badPerson.role).toBe("修复师");
    expect(badPerson.shift).toBe("早班");
    // 重复 id 已拆开
    expect(new Set(v2.jobs.map((j) => j.id)).size).toBe(v2.jobs.length);
    // 撤销栈只保留合法快照
    expect(v2.undo.length).toBe(1);
    expect(v2.undo[0].jobs[0].code).toBe("U-1");
    // 挂到不存在卷的任务被收容到兜底卷，不丢失
    expect(v2.reels.some((r) => r.name === "未命名胶片卷")).toBe(true);
  });

  test("有效 v2 优先于 v1（不再迁移旧版）", async () => {
    // 同时放干净 v2 与可迁移 v1，页面必须采用 v2
    const cleanV2 = {
      startDate: "2026-09-01",
      reels: [{ id: "rr1", name: "V2专属卷" }],
      people: [
        { id: "qq1", name: "V2档案", role: "资料管理员", shift: "早班" },
        { id: "qq2", name: "V2修复", role: "修复师", shift: "早班" }
      ],
      equipment: [{ id: "zz1", name: "清洁台" }, { id: "zz2", name: "抛光机" }],
      jobs: [{ id: "vj1", reelId: "rr1", code: "V2-ONLY", damages: ["dust"], priority: "中", note: "", deps: [], sched: {} }],
      undo: []
    };
    await setStore(page, V2, JSON.stringify(cleanV2));
    await setStore(page, V1, JSON.stringify(v1Payload()));
    await page.reload();
    await openRepair(page);
    await expect(page.locator("#rLoadNotices")).toBeHidden();
    await expect(page.locator("#rStatJobs")).toContainText("1 项");
    await expect(page.locator("#rReelFilter")).toContainText("V2专属卷");
    await expect(page.locator("#rReelFilter")).not.toContainText("老库房甲卷");
    expect(await jobIdByCode(page, "V2-ONLY")).toBeTruthy();
    expect(await jobIdByCode(page, "OLD-1")).toBeNull();
  });
});
