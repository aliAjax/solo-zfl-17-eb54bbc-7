(function () {
"use strict";
/* 离线修复调度台 —— 纯前端，无网络依赖
 * 数据：胶片卷 / 损伤任务 / 班次人员 / 设备，全部存 localStorage。
 * 排程：按依赖拓扑 + 优先级 + 班次工时 + 人员与设备占用求最早可行日。
 * 门禁：人员重叠、设备重叠、依赖倒置、成环、缺岗、未排程均为冲突，有冲突不能保存。
 */

const REPAIR_STORAGE_KEY = "zfl17-film-repair-desk-v1";

const SHIFTS = {
  早班: { label: "早班", hours: 8, window: "09:00–18:00" },
  晚班: { label: "晚班", hours: 6, window: "18:00–24:00" }
};

const ROLES = ["放映员", "修复师", "资料管理员"];
const PRIORITY_RANK = { 高: 0, 中: 1, 低: 2 };

/* 损伤类型字典：决定负责岗位、默认工时、所需设备、基础风险 */
const DAMAGE_TYPES = [
  { key: "dust", label: "灰尘霉斑清洁", role: "资料管理员", hours: 2, equip: "清洁台", risk: 1 },
  { key: "scratch", label: "划痕打磨", role: "修复师", hours: 6, equip: "抛光机", risk: 3 },
  { key: "perf", label: "齿孔修补", role: "修复师", hours: 4, equip: "接片台", risk: 4 },
  { key: "color", label: "褪色补色校正", role: "修复师", hours: 8, equip: "数字校色台", risk: 4 },
  { key: "splice", label: "接片松动重接", role: "修复师", hours: 3, equip: "接片台", risk: 3 },
  { key: "screen", label: "修复后放映复检", role: "放映员", hours: 2, equip: "放映机", risk: 2 },
  { key: "archive", label: "入库登记归档", role: "资料管理员", hours: 1, equip: null, risk: 1 }
];
const DAMAGE_MAP = Object.fromEntries(DAMAGE_TYPES.map((d) => [d.key, d]));

const uid = () =>
  window.crypto?.randomUUID ? crypto.randomUUID() : `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;

function isoDay(date) {
  return date.toISOString().slice(0, 10);
}
function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + n);
  return isoDay(d);
}
const WEEK = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
function weekday(iso) {
  return WEEK[new Date(`${iso}T00:00:00`).getDay()];
}

/* ---------------- 种子数据：两卷胶片，含跨卷人员与设备占用 ---------------- */

function buildDefaultState() {
  const people = [
    { id: uid(), name: "周放映", role: "放映员", shift: "早班" },
    { id: uid(), name: "何夜班", role: "放映员", shift: "晚班" },
    { id: uid(), name: "林修复", role: "修复师", shift: "早班" },
    { id: uid(), name: "陈补色", role: "修复师", shift: "晚班" },
    { id: uid(), name: "吴档案", role: "资料管理员", shift: "早班" }
  ];
  const eq = (name) => ({ id: uid(), name });
  const equipment = [eq("清洁台"), eq("抛光机"), eq("接片台"), eq("数字校色台"), eq("放映机")];

  const reels = [{ id: uid(), name: "春日试映A卷" }, { id: uid(), name: "资料拷贝B卷" }];

  const jobs = [];
  const addJob = (reelId, code, damages, priority, deps, note) => {
    const job = {
      id: uid(),
      reelId,
      code,
      damages,
      priority,
      deps,
      note,
      assigneeId: null,
      startDay: null,
      pinned: false
    };
    jobs.push(job);
    return job;
  };

  const rA = reels[0].id;
  const rB = reels[1].id;

  const a1 = addJob(rA, "A-006", ["dust"], "中", [], "片段整体积灰，先清洁再检视。");
  const a2 = addJob(rA, "A-006", ["scratch"], "高", [a1.id], "人物近景左侧划痕，需打磨抛光。");
  const a3 = addJob(rA, "A-012", ["perf", "splice"], "高", [a1.id], "齿孔破损且接片松动，同一修复台连续作业。");
  const a4 = addJob(rA, "A-021", ["color"], "中", [], "褪色段落做数字校色。");
  const a5 = addJob(rA, "A卷", ["screen"], "高", [a2.id, a3.id, a4.id], "全部修复完成后整卷放映复检。");
  addJob(rA, "A卷", ["archive"], "低", [a5.id], "复检通过后归档回库。");

  const b1 = addJob(rB, "B-003", ["dust"], "中", [], "拷贝入库前清洁。");
  const b2 = addJob(rB, "B-007", ["splice"], "高", [b1.id], "两处接片松动，需重接。");
  const b3 = addJob(rB, "B-015", ["color"], "中", [b1.id], "偏黄褪色段落补色。");
  addJob(rB, "B卷", ["screen"], "高", [b2.id, b3.id], "修复后晚班复检。");

  return {
    startDate: isoDay(new Date()),
    reels,
    people,
    equipment,
    jobs,
    undo: []
  };
}

function loadRepairState() {
  const saved = localStorage.getItem(REPAIR_STORAGE_KEY);
  if (!saved) return buildDefaultState();
  try {
    const parsed = JSON.parse(saved);
    if (!parsed || !Array.isArray(parsed.jobs) || !Array.isArray(parsed.people)) return buildDefaultState();
    parsed.undo = Array.isArray(parsed.undo) ? parsed.undo : [];
    return parsed;
  } catch {
    return buildDefaultState();
  }
}

let rstate = loadRepairState();
let editingId = null;
const selected = new Set();

/* ---------------- 任务派生属性 ---------------- */

function jobDamageDetail(job) {
  const list = job.damages.map((k) => DAMAGE_MAP[k]).filter(Boolean);
  const hours = list.reduce((s, d) => s + d.hours, 0) || 1;
  const primary = [...list].sort((a, b) => b.hours - a.hours)[0] || DAMAGE_TYPES[0];
  const equipLabel = primary.equip;
  return { list, hours, role: primary.role, equipLabel };
}

function jobSpanDays(job, person) {
  const cap = SHIFTS[person.shift]?.hours || 8;
  return Math.max(1, Math.ceil(jobDamageDetail(job).hours / cap));
}

function personById(id) {
  return rstate.people.find((p) => p.id === id) || null;
}
function reelById(id) {
  return rstate.reels.find((r) => r.id === id) || null;
}
function jobById(id) {
  return rstate.jobs.find((j) => j.id === id) || null;
}

/* ---------------- 依赖成环检测（Kahn 残留节点即环上节点） ---------------- */

function findCycleJobs(jobs) {
  const indeg = new Map(jobs.map((j) => [j.id, 0]));
  const ids = new Set(jobs.map((j) => j.id));
  for (const j of jobs) {
    for (const d of j.deps) if (ids.has(d)) indeg.set(j.id, (indeg.get(j.id) || 0) + 1);
  }
  const queue = jobs.filter((j) => indeg.get(j.id) === 0).map((j) => j.id);
  const removed = new Set();
  while (queue.length) {
    const id = queue.shift();
    removed.add(id);
    for (const j of jobs) {
      if (j.deps.includes(id)) {
        indeg.set(j.id, indeg.get(j.id) - 1);
        if (indeg.get(j.id) === 0) queue.push(j.id);
      }
    }
  }
  return new Set(jobs.map((j) => j.id).filter((id) => !removed.has(id)));
}

/* ---------------- 自动排程：拓扑 + 优先级，钉住手动拖拽，避让人员与设备 ---------------- */

function jobInterval(job) {
  const p = personById(job.assigneeId);
  if (!p || job.startDay == null) return null;
  return { start: job.startDay, end: job.startDay + jobSpanDays(job, p) - 1 };
}

function autoSchedule() {
  const cycleIds = findCycleJobs(rstate.jobs);
  const jobs = rstate.jobs;

  // 仅重排未钉选的任务；钉住的（手动拖定）视为固定占用
  for (const j of jobs) {
    if (!j.pinned) {
      j.assigneeId = null;
      j.startDay = null;
    }
  }

  const personBusy = new Map(); // personId -> Set(占用工作日)
  const equipBusy = new Map(); // equipName -> Set(占用工作日)
  const mark = (map, key, day) => {
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(day);
  };
  for (const j of jobs) {
    if (j.pinned && j.assigneeId != null && j.startDay != null && !cycleIds.has(j.id)) {
      const p = personById(j.assigneeId);
      if (!p) continue;
      const span = jobSpanDays(j, p);
      for (let d = j.startDay; d < j.startDay + span; d++) {
        mark(personBusy, p.id, d);
        const eq = jobDamageDetail(j).equipLabel;
        if (eq) mark(equipBusy, eq, d);
      }
    }
  }

  const indeg = new Map(jobs.map((j) => [j.id, 0]));
  const ids = new Set(jobs.map((j) => j.id));
  for (const j of jobs) {
    if (cycleIds.has(j.id)) continue;
    indeg.set(
      j.id,
      j.deps.filter((d) => ids.has(d) && !cycleIds.has(d)).length
    );
  }

  let remaining = jobs.filter((j) => !cycleIds.has(j.id) && !j.pinned);

  const earliestStart = (job) => {
    let day = 0;
    for (const depId of job.deps) {
      const dep = jobById(depId);
      if (!dep || cycleIds.has(depId)) continue;
      const iv = jobInterval(dep);
      if (!iv) return null; // 依赖尚未排上
      day = Math.max(day, iv.end + 1);
    }
    return day;
  };

  const canPlace = (person, job, firstDay) => {
    const span = jobSpanDays(job, person);
    const eq = jobDamageDetail(job).equipLabel;
    for (let d = firstDay; d < firstDay + span; d++) {
      if (personBusy.get(person.id)?.has(d)) return false;
      if (eq && equipBusy.get(eq)?.has(d)) return false;
    }
    return true;
  };

  let guard = jobs.length * jobs.length + 4;
  while (remaining.length && guard-- > 0) {
    const ready = remaining.filter((j) => indeg.get(j.id) === 0 && earliestStart(j) !== null);
    if (!ready.length) break;
    ready.sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.code.localeCompare(b.code, "zh"));
    const job = ready[0];
    const role = jobDamageDetail(job).role;
    const e = earliestStart(job);
    let best = null;
    for (const person of rstate.people.filter((p) => p.role === role)) {
      for (let day = e; day < e + 60; day++) {
        if (canPlace(person, job, day)) {
          const finish = day + jobSpanDays(job, person) - 1;
          if (!best || finish < best.finish || (finish === best.finish && person.name < best.person.name)) {
            best = { person, day, finish };
          }
          break;
        }
      }
    }
    if (best) {
      job.assigneeId = best.person.id;
      job.startDay = best.day;
      const span = jobSpanDays(job, best.person);
      const eq = jobDamageDetail(job).equipLabel;
      for (let d = best.day; d < best.day + span; d++) {
        mark(personBusy, best.person.id, d);
        if (eq) mark(equipBusy, eq, d);
      }
    }
    indeg.set(job.id, -1);
    remaining = remaining.filter((j) => j !== job);
    for (const j of remaining) {
      if (j.deps.includes(job.id)) indeg.set(j.id, Math.max(0, indeg.get(j.id) - 1));
    }
  }
}

/* ---------------- 冲突分析 ---------------- */

function analyze() {
  const conflicts = [];
  const cycleIds = findCycleJobs(rstate.jobs);
  const cycleJobs = rstate.jobs.filter((j) => cycleIds.has(j.id));
  if (cycleJobs.length) {
    conflicts.push({
      type: "cycle",
      jobIds: cycleJobs.map((j) => j.id),
      msg: `依赖成环：${cycleJobs.map((j) => j.code).join(" → ")} 等 ${cycleJobs.length} 项互相依赖，无法开工`
    });
  }

  const intervals = new Map();
  for (const j of rstate.jobs) {
    if (cycleIds.has(j.id)) continue;
    const iv = jobInterval(j);
    if (iv) intervals.set(j.id, iv);
  }
  const overlap = (a, b) => a.start <= b.end && b.start <= a.end;

  // 同一人员不能重叠
  for (const p of rstate.people) {
    const mine = rstate.jobs.filter((j) => j.assigneeId === p.id && intervals.has(j.id));
    for (let i = 0; i < mine.length; i++) {
      for (let k = i + 1; k < mine.length; k++) {
        if (overlap(intervals.get(mine[i].id), intervals.get(mine[k].id))) {
          conflicts.push({
            type: "person",
            jobIds: [mine[i].id, mine[k].id],
            msg: `人员冲突：${p.name}（${p.shift}）在同一工作日承担 ${mine[i].code} 与 ${mine[k].code}`
          });
        }
      }
    }
  }

  // 同一设备不能重叠
  const byEquip = new Map();
  for (const j of rstate.jobs) {
    if (!intervals.has(j.id)) continue;
    const eq = jobDamageDetail(j).equipLabel;
    if (!eq) continue;
    if (!rstate.equipment.some((e) => e.name === eq)) {
      conflicts.push({ type: "equip-missing", jobIds: [j.id], msg: `设备缺失：${j.code} 需要的「${eq}」已被删除` });
      continue;
    }
    if (!byEquip.has(eq)) byEquip.set(eq, []);
    byEquip.get(eq).push(j);
  }
  for (const [eq, list] of byEquip) {
    for (let i = 0; i < list.length; i++) {
      for (let k = i + 1; k < list.length; k++) {
        if (overlap(intervals.get(list[i].id), intervals.get(list[k].id))) {
          conflicts.push({
            type: "equipment",
            jobIds: [list[i].id, list[k].id],
            msg: `设备冲突：${list[i].code} 与 ${list[k].code} 同日占用「${eq}」`
          });
        }
      }
    }
  }

  // 依赖必须先完成
  for (const j of rstate.jobs) {
    if (cycleIds.has(j.id) || !intervals.has(j.id)) continue;
    for (const depId of j.deps) {
      const dep = jobById(depId);
      if (!dep) continue;
      if (cycleIds.has(depId) || !intervals.has(depId)) {
        conflicts.push({
          type: "dependency",
          jobIds: [j.id, depId],
          msg: `依赖未排：${j.code} 依赖的 ${dep.code} 尚未排程（在环中或无资源）`
        });
      } else if (intervals.get(depId).end >= intervals.get(j.id).start) {
        conflicts.push({
          type: "dependency",
          jobIds: [j.id, depId],
          msg: `依赖倒置：${dep.code} 尚未完工，${j.code} 就已开工`
        });
      }
    }
  }

  // 岗位必须匹配
  for (const j of rstate.jobs) {
    if (!intervals.has(j.id)) continue;
    const p = personById(j.assigneeId);
    const need = jobDamageDetail(j).role;
    if (p && p.role !== need) {
      conflicts.push({
        type: "role",
        jobIds: [j.id],
        msg: `岗位不符：${j.code} 需要${need}，却拖给了${p.role}${p.name}`
      });
    }
  }

  // 环外未排程任务
  for (const j of rstate.jobs) {
    if (!cycleIds.has(j.id) && !intervals.has(j.id)) {
      const role = jobDamageDetail(j).role;
      const hasRole = rstate.people.some((p) => p.role === role);
      conflicts.push({
        type: "unassigned",
        jobIds: [j.id],
        msg: hasRole
          ? `未能排程：${j.code} 在现有班次与设备占用下找不到可行窗口（可手动拖入上方班次格）`
          : `未能排程：${j.code} 需要${role}，当前没有该岗位人员`
      });
    }
  }

  const makespan = rstate.jobs.reduce((m, j) => {
    const iv = intervals.get(j.id);
    return iv ? Math.max(m, iv.end + 1) : m;
  }, 0);

  // 风险指数：损伤基础风险 × 优先级系数 + 冲突/缺排惩罚 + 工期
  let base = 0;
  for (const j of rstate.jobs) {
    const dmgRisk = jobDamageDetail(j).list.reduce((s, d) => s + d.risk, 0);
    base += Math.round(dmgRisk * (j.priority === "高" ? 1.4 : j.priority === "低" ? 0.7 : 1));
  }
  const hard = conflicts.filter((c) => c.type === "person" || c.type === "equipment" || c.type === "cycle").length;
  const soft = conflicts.length - hard;
  const risk = Math.min(99, base + hard * 25 + soft * 8 + makespan * 2);
  const riskDrivers = [
    `损伤与优先级基础风险 ${base}`,
    `硬冲突（人员/设备/成环）${hard} 项 ×25`,
    `其他冲突与缺排 ${soft} 项 ×8`,
    `计划工期 ${makespan} 个工作日 ×2`
  ];

  return { conflicts, makespan, risk, riskDrivers, cycleIds };
}

/* ---------------- 持久化：有冲突一律不落盘 ---------------- */

function persist(analysis) {
  if (analysis.conflicts.length > 0) return false;
  const { ...snapshot } = rstate;
  localStorage.setItem(REPAIR_STORAGE_KEY, JSON.stringify(snapshot));
  return true;
}

/* ---------------- DOM ---------------- */

const $ = (sel) => document.querySelector(sel);
const rEls = {
  roleView: $("#rRoleView"),
  reelFilter: $("#rReelFilter"),
  startDate: $("#rStartDate"),
  search: $("#rSearch"),
  undo: $("#rUndoBtn"),
  exportBtn: $("#rExportBtn"),
  statJobs: $("#rStatJobs"),
  statMakespan: $("#rStatMakespan"),
  statRisk: $("#rStatRisk"),
  statConflicts: $("#rStatConflicts"),
  form: $("#rJobForm"),
  formTitle: $("#rFormTitle"),
  fReel: $("#fReel"),
  fNewReelWrap: $("#fNewReelWrap"),
  fNewReel: $("#fNewReel"),
  fSegCode: $("#fSegCode"),
  fDamages: $("#fDamages"),
  fPriority: $("#fPriority"),
  fRole: $("#fRole"),
  fEquip: $("#fEquip"),
  fHours: $("#fHours"),
  fDeps: $("#fDeps"),
  fNote: $("#fNote"),
  fError: $("#fError"),
  fSubmit: $("#fSubmit"),
  fCancelEdit: $("#fCancelEdit"),
  peopleList: $("#rPeopleList"),
  equipList: $("#rEquipList"),
  personForm: $("#rPersonForm"),
  pName: $("#pName"),
  pRole: $("#pRole"),
  pShift: $("#pShift"),
  equipForm: $("#rEquipForm"),
  eName: $("#eName"),
  autoBtn: $("#rAutoBtn"),
  saveBtn: $("#rSaveBtn"),
  banner: $("#rBlockBanner"),
  gantt: $("#rGantt"),
  ganttScroll: $("#rGanttScroll"),
  tray: $("#rTray"),
  jobList: $("#rJobList"),
  selCount: $("#rSelCount"),
  selectAll: $("#rSelectAll"),
  clearSel: $("#rClearSel"),
  conflictList: $("#rConflictList"),
  riskBox: $("#rRiskBox"),
  bField: $("#bField"),
  bPriority: $("#bPriority"),
  bDamages: $("#bDamages"),
  bReplace: $("#bReplace"),
  bModeWrap: $("#bModeWrap"),
  bPreviewBtn: $("#bPreviewBtn"),
  modalBackdrop: $("#rModalBackdrop"),
  modalTitle: $("#rModalTitle"),
  modalBody: $("#rModalBody"),
  modalCancel: $("#rModalCancel"),
  modalConfirm: $("#rModalConfirm"),
  toast: $("#rToast")
};

let lastAnalysis = null;
let pendingBatch = null;

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c])
  );
}

function toast(msg, kind = "ok") {
  rEls.toast.textContent = msg;
  rEls.toast.className = `toast show ${kind}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    rEls.toast.className = "toast";
    rEls.toast.hidden = true;
  }, 3200);
  rEls.toast.hidden = false;
}

/* ---------------- 渲染 ---------------- */

function visibleJobs() {
  const reel = rEls.reelFilter.value;
  const kw = rEls.search.value.trim();
  const role = rEls.roleView.value;
  return rstate.jobs.filter((j) => {
    if (reel !== "all" && j.reelId !== reel) return false;
    if (kw && !`${j.code}${j.note}${j.damages.map((k) => DAMAGE_MAP[k]?.label || "").join("")}`.includes(kw)) return false;
    if (role !== "all" && jobDamageDetail(j).role !== role) return false;
    return true;
  });
}

function renderStats() {
  rEls.statJobs.textContent = rstate.jobs.length;
  rEls.statMakespan.textContent = lastAnalysis.makespan ? `${lastAnalysis.makespan}天` : "—";
  const risk = lastAnalysis.risk;
  rEls.statRisk.textContent = risk;
  rEls.statRisk.className = risk >= 55 ? "hot" : risk >= 30 ? "warm" : "cool";
  const n = lastAnalysis.conflicts.length;
  rEls.statConflicts.textContent = n;
  rEls.statConflicts.parentElement.classList.toggle("is-danger", n > 0);
}

function renderReelOptions() {
  const cur = rEls.reelFilter.value;
  rEls.reelFilter.innerHTML =
    `<option value="all">全部胶片卷</option>` +
    rstate.reels.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join("");
  rEls.reelFilter.value = cur && (cur === "all" || rstate.reels.some((r) => r.id === cur)) ? cur : "all";

  rEls.fReel.innerHTML =
    rstate.reels.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join("") +
    `<option value="__new">＋ 新建胶片卷…</option>`;
}

function renderDamageChecks() {
  rEls.fDamages.innerHTML = DAMAGE_TYPES.map(
    (d) =>
      `<label class="check"><input type="checkbox" name="fdmg" value="${d.key}"> <span>${esc(d.label)}</span><small>${d.role}·${d.hours}h${d.equip ? `·${d.equip}` : ""}</small></label>`
  ).join("");
  rEls.bDamages.innerHTML = DAMAGE_TYPES.map(
    (d) => `<label class="check"><input type="checkbox" name="bdmg" value="${d.key}"> <span>${esc(d.label)}</span></label>`
  ).join("");
  rEls.fDamages.addEventListener("change", syncDerivedFields);
}

function syncDerivedFields() {
  const keys = [...rEls.fDamages.querySelectorAll("input:checked")].map((i) => i.value);
  const list = keys.map((k) => DAMAGE_MAP[k]).filter(Boolean);
  if (!list.length) {
    rEls.fRole.value = "";
    rEls.fEquip.value = "";
    rEls.fHours.value = "";
    return;
  }
  const hours = list.reduce((s, d) => s + d.hours, 0);
  const primary = [...list].sort((a, b) => b.hours - a.hours)[0];
  rEls.fRole.value = primary.role;
  rEls.fEquip.value = [...new Set(list.map((d) => d.equip).filter(Boolean))].join("、") || "无专用设备";
  rEls.fHours.value = hours;
}

function renderDepChecks() {
  const groups = new Map();
  for (const j of rstate.jobs) {
    if (j.id === editingId) continue;
    if (!groups.has(j.reelId)) groups.set(j.reelId, []);
    groups.get(j.reelId).push(j);
  }
  const editing = editingId ? jobById(editingId) : null;
  rEls.fDeps.innerHTML = [...groups.entries()]
    .map(([reelId, list]) => {
      const reel = reelById(reelId);
      return `
        <fieldset class="dep-group">
          <legend>${esc(reel?.name || "未知卷")}</legend>
          ${list
            .map((j) => {
              const labels = j.damages.map((k) => DAMAGE_MAP[k]?.label).filter(Boolean).join("、");
              const checked = editing?.deps.includes(j.id) ? "checked" : "";
              return `<label class="check"><input type="checkbox" name="fdep" value="${j.id}"> <span>${esc(j.code)}｜${esc(labels)}</span></label>`;
            })
            .join("")}
        </fieldset>`;
    })
    .join("") || `<p class="empty">还没有可依赖的任务，先登记本卷第一项损伤。</p>`;
}

function renderResources() {
  rEls.peopleList.innerHTML = rstate.people
    .map(
      (p) => `
      <li>
        <div><strong>${esc(p.name)}</strong><span class="res-meta">${p.role} · ${p.shift} ${SHIFTS[p.shift].window}</span></div>
        <button type="button" class="mini" data-del-person="${p.id}" title="删除该人员（其任务回到待排）">×</button>
      </li>`
    )
    .join("");
  rEls.equipList.innerHTML = rstate.equipment
    .map(
      (e) => `
      <li>
        <div><strong>${esc(e.name)}</strong></div>
        <button type="button" class="mini" data-del-equip="${e.id}" title="删除该设备">×</button>
      </li>`
    )
    .join("");
  rEls.pRole.innerHTML = ROLES.map((r) => `<option>${r}</option>`).join("");
}

function conflictedJobIds() {
  return new Set(lastAnalysis.conflicts.flatMap((c) => c.jobIds));
}

function renderGantt() {
  const days = Math.max(10, lastAnalysis.makespan + 1);
  const role = rEls.roleView.value;
  const lanes = rstate.people.filter((p) => role === "all" || p.role === role);
  const bad = conflictedJobIds();

  const head = `
    <div class="gantt-corner">人员 / 工作日</div>
    ${Array.from({ length: days }, (_, d) => {
      const iso = addDays(rstate.startDate, d);
      const weekend = new Date(`${iso}T00:00:00`).getDay() % 6 === 0;
      return `<div class="gantt-day ${weekend ? "weekend" : ""}"><strong>第${d + 1}天</strong><span>${iso.slice(5)} ${weekday(iso)}</span></div>`;
    }).join("")}`;

  const personRows = lanes
    .map((p) => {
      const cells = Array.from({ length: days }, (_, d) => `<div class="lane-cell" data-cell-day="${d}" data-person="${p.id}"></div>`).join("");
      const blocks = rstate.jobs
        .filter((j) => j.assigneeId === p.id && j.startDay != null)
        .map((j) => {
          const span = Math.min(jobSpanDays(j, p), days - j.startDay);
          const detail = jobDamageDetail(j);
          const reel = reelById(j.reelId);
          return `<div class="gantt-block pri-${j.priority} ${bad.has(j.id) ? "conflict" : ""}"
            draggable="true" data-job="${j.id}" title="${esc(j.code)}｜${esc(detail.list.map((d) => d.label).join("、"))}｜${detail.hours}h"
            style="grid-column:${j.startDay + 2} / span ${span}">
            <strong>${esc(j.code)}</strong><span>${esc(reel?.name || "")}</span><em>${detail.hours}h</em>
          </div>`;
        })
        .join("");
      return `
        <div class="lane-name"><strong>${esc(p.name)}</strong><span>${p.role} · ${p.shift}</span></div>
        <div class="lane" data-person-lane="${p.id}">${cells}${blocks}</div>`;
    })
    .join("");

  const eqRows = rstate.equipment
    .map((e) => {
      const cells = Array.from({ length: days }, (_, d) => `<div class="lane-cell equip-cell" data-cell-day="${d}"></div>`).join("");
      const blocks = rstate.jobs
        .filter((j) => j.startDay != null && jobDamageDetail(j).equipLabel === e.name && personById(j.assigneeId))
        .map((j) => {
          const p = personById(j.assigneeId);
          const span = Math.min(jobSpanDays(j, p), days - j.startDay);
          return `<div class="equip-block pri-${j.priority} ${bad.has(j.id) ? "conflict" : ""}" style="grid-column:${j.startDay + 2} / span ${span}">
            ${esc(j.code)}<em>${esc(p.name)}</em></div>`;
        })
        .join("");
      return `<div class="lane-name equip-name"><strong>设备：${esc(e.name)}</strong></div><div class="lane equip-lane">${cells}${blocks}</div>`;
    })
    .join("");

  rEls.gantt.style.gridTemplateColumns = `158px repeat(${days}, 76px)`;
  rEls.gantt.innerHTML = head + personRows + eqRows;

  // 待排 / 成环托盘
  const trayJobs = rstate.jobs.filter((j) => j.assigneeId == null || lastAnalysis.cycleIds.has(j.id));
  rEls.tray.innerHTML =
    trayJobs
      .map((j) => {
        const detail = jobDamageDetail(j);
        const inCycle = lastAnalysis.cycleIds.has(j.id);
        return `<div class="tray-card pri-${j.priority} ${inCycle ? "cycle" : ""}" draggable="true" data-job="${j.id}">
          <strong>${esc(j.code)}</strong>
          <span>${esc(detail.list.map((d) => d.label).join("、")) || "未选损伤"}</span>
          <em>${detail.hours}h · ${detail.role}${detail.equipLabel ? ` · ${detail.equipLabel}` : ""}</em>
          ${inCycle ? '<b class="cycle-badge">依赖成环</b>' : '<b class="wait-badge">待排程</b>'}
        </div>`;
      })
      .join("") || `<p class="empty">所有任务均已排入班次。</p>`;
}

function renderJobList() {
  const bad = conflictedJobIds();
  const jobs = visibleJobs();
  rEls.selCount.textContent = selected.size ? `（已选 ${selected.size} 项）` : "";
  rEls.jobList.innerHTML = jobs
    .map((j) => {
      const detail = jobDamageDetail(j);
      const reel = reelById(j.reelId);
      const p = personById(j.assigneeId);
      const depNames = j.deps
        .map((id) => jobById(id)?.code)
        .filter(Boolean)
        .join("、");
      const sched =
        p && j.startDay != null
          ? `${esc(p.name)} · 第${j.startDay + 1}天起`
          : lastAnalysis.cycleIds.has(j.id)
            ? "依赖成环"
            : "未排程";
      return `
      <article class="job-card ${bad.has(j.id) ? "conflict" : ""}">
        <label class="job-pick"><input type="checkbox" data-pick="${j.id}" ${selected.has(j.id) ? "checked" : ""}></label>
        <div class="job-body">
          <div class="job-head">
            <strong>${esc(j.code)}</strong>
            <span class="reel-tag">${esc(reel?.name || "未知卷")}</span>
            <span class="prio pri-tag-${j.priority}">${j.priority}</span>
            ${j.pinned ? '<span class="pin-tag">手动钉住</span>' : ""}
          </div>
          <div class="tag-row">${detail.list.map((d) => `<span class="tag">${esc(d.label)}</span>`).join("")}</div>
          <p class="job-meta">${detail.hours}h · ${detail.role}${detail.equipLabel ? ` · ${esc(detail.equipLabel)}` : ""} · ${sched}</p>
          ${depNames ? `<p class="job-deps">依赖：${esc(depNames)}</p>` : ""}
          ${j.note ? `<p class="job-note">${esc(j.note)}</p>` : ""}
        </div>
        <div class="job-actions">
          <button type="button" class="mini" data-edit="${j.id}">改</button>
          <button type="button" class="mini danger" data-del-job="${j.id}">删</button>
        </div>
      </article>`;
    })
    .join("") || `<p class="empty">没有符合筛选的任务。</p>`;

  const visibleIds = jobs.map((j) => j.id);
  rEls.selectAll.checked = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
}

function renderConflicts() {
  rEls.conflictList.innerHTML =
    lastAnalysis.conflicts
      .map(
        (c) => `<div class="conflict-item ct-${c.type}">
          <strong>${conflictTypeLabel(c.type)}</strong><span>${esc(c.msg)}</span></div>`
      )
      .join("") || `<p class="empty">当前排程无冲突，可保存或导出班表。</p>`;

  const level = lastAnalysis.risk >= 55 ? "高风险" : lastAnalysis.risk >= 30 ? "中风险" : "低风险";
  rEls.riskBox.innerHTML = `
    <div class="risk-meter r-${lastAnalysis.risk >= 55 ? "high" : lastAnalysis.risk >= 30 ? "mid" : "low"}">
      <strong>${lastAnalysis.risk}</strong><span>${level}</span>
    </div>
    <ul class="risk-drivers">${lastAnalysis.riskDrivers.map((d) => `<li>${esc(d)}</li>`).join("")}</ul>`;
}

function conflictTypeLabel(t) {
  return {
    cycle: "依赖成环",
    person: "人员重叠",
    equipment: "设备重叠",
    "equip-missing": "设备缺失",
    dependency: "依赖违例",
    role: "岗位不符",
    unassigned: "待排程"
  }[t] || t;
}

function renderBanner() {
  const n = lastAnalysis.conflicts.length;
  if (n) {
    rEls.banner.hidden = false;
    rEls.banner.innerHTML = `⛔ 检测到 <strong>${n}</strong> 项未解决冲突，排程<strong>不能保存</strong>（刷新将回到上次保存版本）。请拖动色块调整，或解除依赖后重排。`;
  } else {
    rEls.banner.hidden = true;
  }
  rEls.saveBtn.disabled = n > 0;
  rEls.saveBtn.title = n > 0 ? "存在未解决冲突，无法保存" : "保存当前排程";
  rEls.exportBtn.disabled = false;
}

function renderAll() {
  autoSchedule();
  lastAnalysis = analyze();
  persist(lastAnalysis);
  renderStats();
  renderReelOptions();
  renderResources();
  renderDepChecks();
  if (!editingId) syncDerivedFields();
  renderGantt();
  renderJobList();
  renderConflicts();
  renderBanner();
  rEls.startDate.value = rstate.startDate;
  rEls.undo.disabled = rstate.undo.length === 0;
}

/* ---------------- 表单：登记 / 编辑 ---------------- */

function startEdit(id) {
  const j = jobById(id);
  if (!j) return;
  editingId = id;
  rEls.formTitle.textContent = `编辑任务 ${j.code}`;
  rEls.fSubmit.textContent = "保存修改";
  rEls.fCancelEdit.hidden = false;
  rEls.fReel.value = rstate.reels.some((r) => r.id === j.reelId) ? j.reelId : "__new";
  rEls.fNewReelWrap.hidden = rEls.fReel.value !== "__new";
  rEls.fSegCode.value = j.code;
  rEls.fDamages.querySelectorAll("input").forEach((i) => (i.checked = j.damages.includes(i.value)));
  rEls.fPriority.value = j.priority;
  rEls.fNote.value = j.note || "";
  renderDepChecks();
  rEls.fDeps.querySelectorAll("input").forEach((i) => (i.checked = j.deps.includes(i.value)));
  syncDerivedFields();
  rEls.fError.hidden = true;
  rEls.form.scrollIntoView({ behavior: "smooth", block: "start" });
}

function resetForm() {
  editingId = null;
  rEls.form.reset();
  rEls.formTitle.textContent = "登记损伤 / 修复任务";
  rEls.fSubmit.textContent = "登记任务";
  rEls.fCancelEdit.hidden = true;
  rEls.fNewReelWrap.hidden = true;
  rEls.fError.hidden = true;
  renderDepChecks();
  syncDerivedFields();
}

rEls.form.addEventListener("submit", (e) => {
  e.preventDefault();
  const damageKeys = [...rEls.fDamages.querySelectorAll("input:checked")].map((i) => i.value);
  const code = rEls.fSegCode.value.trim();
  const error = (msg) => {
    rEls.fError.textContent = msg;
    rEls.fError.hidden = false;
  };
  if (!code) return error("请填写片段编号。");
  if (!damageKeys.length) return error("至少勾选一项损伤类型。");
  let reelId = rEls.fReel.value;
  if (reelId === "__new") {
    const name = rEls.fNewReel.value.trim();
    if (!name) return error("请填写新胶片卷名称。");
    const reel = { id: uid(), name };
    rstate.reels.push(reel);
    reelId = reel.id;
  }
  const deps = [...rEls.fDeps.querySelectorAll("input:checked")].map((i) => i.value).filter((id) => jobById(id));
  const payload = {
    reelId,
    code,
    damages: damageKeys,
    priority: rEls.fPriority.value,
    note: rEls.fNote.value.trim()
  };
  if (editingId) {
    const job = jobById(editingId);
    Object.assign(job, payload, { deps, pinned: false, assigneeId: null, startDay: null });
    toast("任务已修改，已重新排程。");
  } else {
    rstate.jobs.push({ id: uid(), ...payload, deps, assigneeId: null, startDay: null, pinned: false });
    toast("损伤任务已登记，进入排程。");
  }
  resetForm();
  renderAll();
});
rEls.fCancelEdit.addEventListener("click", resetForm);
rEls.fReel.addEventListener("change", () => (rEls.fNewReelWrap.hidden = rEls.fReel.value !== "__new"));

/* ---------------- 资源增删 ---------------- */

rEls.personForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const name = rEls.pName.value.trim();
  if (!name) return;
  rstate.people.push({ id: uid(), name, role: rEls.pRole.value, shift: rEls.pShift.value });
  rEls.personForm.reset();
  renderAll();
});
rEls.equipForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const name = rEls.eName.value.trim();
  if (!name) return;
  rstate.equipment.push({ id: uid(), name });
  rEls.equipForm.reset();
  renderAll();
});
rEls.peopleList.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-del-person]");
  if (!btn) return;
  const p = rstate.people.find((x) => x.id === btn.dataset.delPerson);
  if (!p) return;
  if (!confirm(`删除人员「${p.name}」？其名下任务将回到待排。`)) return;
  rstate.people = rstate.people.filter((x) => x.id !== p.id);
  renderAll();
});
rEls.equipList.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-del-equip]");
  if (!btn) return;
  const eq = rstate.equipment.find((x) => x.id === btn.dataset.delEquip);
  if (!eq) return;
  if (!confirm(`删除设备「${eq.name}」？`)) return;
  rstate.equipment = rstate.equipment.filter((x) => x.id !== eq.id);
  renderAll();
});

/* ---------------- 任务清单操作 ---------------- */

rEls.jobList.addEventListener("click", (e) => {
  const edit = e.target.closest("[data-edit]");
  const del = e.target.closest("[data-del-job]");
  if (edit) return startEdit(edit.dataset.edit);
  if (del) {
    const j = jobById(del.dataset.delJob);
    if (!j) return;
    if (!confirm(`删除任务 ${j.code}？其他任务对它的依赖会一并清除。`)) return;
    rstate.jobs = rstate.jobs.filter((x) => x.id !== j.id);
    for (const x of rstate.jobs) x.deps = x.deps.filter((d) => d !== j.id);
    selected.delete(j.id);
    renderAll();
  }
});
rEls.jobList.addEventListener("change", (e) => {
  const pick = e.target.closest("[data-pick]");
  if (!pick) return;
  if (pick.checked) selected.add(pick.dataset.pick);
  else selected.delete(pick.dataset.pick);
  renderJobList();
});
rEls.selectAll.addEventListener("change", () => {
  const ids = visibleJobs().map((j) => j.id);
  if (rEls.selectAll.checked) ids.forEach((id) => selected.add(id));
  else ids.forEach((id) => selected.delete(id));
  renderJobList();
});
rEls.clearSel.addEventListener("click", () => {
  selected.clear();
  renderJobList();
});

/* ---------------- 甘特拖拽改派 ---------------- */

let dragJobId = null;

document.addEventListener("dragstart", (e) => {
  const block = e.target.closest("[data-job]");
  if (!block || !$("#viewRepair") || $("#viewRepair").hidden) return;
  dragJobId = block.dataset.job;
  rEls.gantt.classList.add("drag-mode");
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", dragJobId);
});
document.addEventListener("dragend", () => {
  dragJobId = null;
  rEls.gantt.classList.remove("drag-mode");
});
rEls.gantt.addEventListener("dragover", (e) => {
  const cell = e.target.closest("[data-cell-day]");
  if (!cell || !dragJobId || cell.classList.contains("equip-cell")) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
  rEls.gantt.querySelectorAll(".lane-cell.drop-hot").forEach((c) => c.classList.remove("drop-hot"));
  cell.classList.add("drop-hot");
});
rEls.gantt.addEventListener("dragleave", (e) => e.target.closest("[data-cell-day]")?.classList.remove("drop-hot"));
rEls.gantt.addEventListener("drop", (e) => {
  const cell = e.target.closest("[data-cell-day]");
  rEls.gantt.querySelectorAll(".lane-cell.drop-hot").forEach((c) => c.classList.remove("drop-hot"));
  if (!cell || !dragJobId || cell.classList.contains("equip-cell")) return;
  e.preventDefault();
  const job = jobById(dragJobId);
  if (!job) return;
  job.assigneeId = cell.dataset.person;
  job.startDay = Number(cell.dataset.cellDay);
  job.pinned = true;
  renderAll();
  const related = lastAnalysis.conflicts.filter((c) => c.jobIds.includes(job.id));
  toast(related.length ? `已改派，立即发现 ${related.length} 项冲突，解除前不能保存。` : "已改派并钉住，无冲突。", related.length ? "err" : "ok");
});

/* ---------------- 全自动重排 / 保存 ---------------- */

rEls.autoBtn.addEventListener("click", () => {
  for (const j of rstate.jobs) j.pinned = false;
  renderAll();
  toast("已清除手动钉住并全自动重排。");
});
rEls.saveBtn.addEventListener("click", () => {
  if (lastAnalysis.conflicts.length) {
    toast("仍有未解决冲突，不能保存。", "err");
    return;
  }
  persist(lastAnalysis);
  toast("排程已保存，刷新页面仍保留。");
});

rEls.startDate.addEventListener("change", () => {
  if (!rEls.startDate.value) return;
  rstate.startDate = rEls.startDate.value;
  renderAll();
});
rEls.roleView.addEventListener("change", renderAll);
rEls.reelFilter.addEventListener("change", renderJobList);
rEls.search.addEventListener("input", renderJobList);

/* ---------------- 批量调整：预览 -> 原子提交 -> 失败全量回退 / 撤销 ---------------- */

rEls.bField.addEventListener("change", () => {
  const isPri = rEls.bField.value === "priority";
  rEls.bPriority.hidden = !isPri;
  rEls.bDamages.hidden = isPri;
  rEls.bModeWrap.hidden = isPri;
});

// 在深拷贝上逐步执行批量改动并跑全局校验；通过后返回候选作业集
function simulateBatch(ids, field, value) {
  // 在深拷贝上逐步执行；任何一步失败立即抛出，已执行步骤随拷贝丢弃 => 全量回退
  const jobs = rstate.jobs.map((j) => ({ ...j, damages: [...j.damages], deps: [...j.deps] }));
  const log = [];
  ids.forEach((id, i) => {
    const job = jobs.find((j) => j.id === id);
    if (!job) throw new Error(`第 ${i + 1} 步失败：任务已不存在，事务终止。`);
    const before = field === "priority" ? job.priority : job.damages.map((k) => DAMAGE_MAP[k]?.label).join("、");
    if (field === "priority") {
      if (!PRIORITY_RANK.hasOwnProperty(value.priority)) throw new Error(`第 ${i + 1} 步失败：优先级取值非法。`);
      job.priority = value.priority;
    } else {
      const keys = value.damages;
      if (!keys.length) throw new Error(`第 ${i + 1} 步失败：损伤类型不能为空（${job.code}），事务终止。`);
      if (keys.some((k) => !DAMAGE_MAP[k])) throw new Error(`第 ${i + 1} 步失败：包含未知损伤类型。`);
      job.damages = value.replace ? [...keys] : [...new Set([...job.damages, ...keys])];
    }
    const after = field === "priority" ? job.priority : job.damages.map((k) => DAMAGE_MAP[k].label).join("、");
    log.push({ code: job.code, before, after });
  });
  // 全局校验：批量结果不允许产生新依赖环
  // 全局校验：批量结果不允许产生新依赖环
  const cycle = findCycleJobs(jobs);
  if (cycle.size) {
    const names = jobs.filter((j) => cycle.has(j.id)).map((j) => j.code);
    throw new Error(`全局校验失败：改动后依赖成环（${names.join("、")}），全部回退。`);
  }
  return { jobs, log };
}

rEls.bPreviewBtn.addEventListener("click", () => {
  const ids = [...selected].filter((id) => jobById(id));
  if (!ids.length) return toast("请先在任务清单勾选要批量调整的任务。", "err");
  const field = rEls.bField.value;
  const value =
    field === "priority"
      ? { priority: rEls.bPriority.value }
      : {
          damages: [...rEls.bDamages.querySelectorAll("input:checked")].map((i) => i.value),
          replace: rEls.bReplace.checked
        };

  const beforeAnalysis = analyze();
  let result;
  try {
    result = simulateBatch(ids, field, value);
  } catch (err) {
    pendingBatch = null;
    rEls.modalTitle.textContent = "批量调整被拒绝（未写入任何数据）";
    rEls.modalBody.innerHTML = `
      <div class="rollback-box">
        <strong>⛔ ${esc(err.message)}</strong>
        <p>事务已整体回退：共计划 ${ids.length} 步，<strong>0</strong> 步生效，现有任务、排程与冲突状态保持不变。</p>
      </div>`;
    rEls.modalConfirm.disabled = true;
    rEls.modalBackdrop.hidden = false;
    return;
  }

  // 在候选作业集上自动排程并算影响，算完恢复现场，绝不污染当前数据
  const savedJobs = rstate.jobs;
  rstate.jobs = result.jobs;
  autoSchedule();
  const afterAnalysis = analyze();
  rstate.jobs = savedJobs;

  pendingBatch = { ids, field, value };
  const deltaRisk = afterAnalysis.risk - beforeAnalysis.risk;
  const deltaMake = afterAnalysis.makespan - beforeAnalysis.makespan;
  rEls.modalTitle.textContent = `批量调整影响预览（${ids.length} 项）`;
  rEls.modalBody.innerHTML = `
    <div class="preview-grid">
      <div><span>总工期</span><strong>${beforeAnalysis.makespan}天 → ${afterAnalysis.makespan}天</strong><em class="${deltaMake > 0 ? "bad" : deltaMake < 0 ? "good" : ""}">${deltaMake === 0 ? "不变" : `${deltaMake > 0 ? "+" : ""}${deltaMake}天`}</em></div>
      <div><span>风险指数</span><strong>${beforeAnalysis.risk} → ${afterAnalysis.risk}</strong><em class="${deltaRisk > 0 ? "bad" : deltaRisk < 0 ? "good" : ""}">${deltaRisk === 0 ? "不变" : `${deltaRisk > 0 ? "+" : ""}${deltaRisk}`}</em></div>
      <div><span>冲突数量</span><strong>${beforeAnalysis.conflicts.length} → ${afterAnalysis.conflicts.length}</strong><em class="${afterAnalysis.conflicts.length ? "bad" : "good"}">${afterAnalysis.conflicts.length ? "提交后需先解冲突才能保存" : "无冲突"}</em></div>
    </div>
    <div class="preview-list">
      <h3>逐任务改动</h3>
      <ul>${result.log.map((l) => `<li><strong>${esc(l.code)}</strong> ${esc(l.before || "—")} → ${esc(l.after)}</li>`).join("")}</ul>
      ${afterAnalysis.conflicts.length ? `<h3>提交后将出现的冲突</h3><ul>${afterAnalysis.conflicts.map((c) => `<li class="bad">${esc(c.msg)}</li>`).join("")}</ul>` : ""}
    </div>
    <p class="hint">确认后 ${ids.length} 项将作为一次事务提交，任一步失败已在预检中拦截；提交后可用「撤销上次提交」整体还原。</p>`;
  rEls.modalConfirm.disabled = false;
  rEls.modalBackdrop.hidden = false;
});

rEls.modalCancel.addEventListener("click", () => {
  rEls.modalBackdrop.hidden = true;
  pendingBatch = null;
});
rEls.modalConfirm.addEventListener("click", () => {
  if (!pendingBatch) return;
  const { ids, field, value } = pendingBatch;
  // 再次执行真实事务；失败则用备份快照恢复
  const backup = rstate.jobs.map((j) => ({ ...j, damages: [...j.damages], deps: [...j.deps] }));
  try {
    const { jobs } = simulateBatch(ids, field, value);
    rstate.undo.push({ label: `批量${field === "priority" ? "改优先级" : "改损伤"} ${ids.length} 项`, jobs: backup });
    if (rstate.undo.length > 10) rstate.undo.shift();
    rstate.jobs = jobs;
    for (const j of rstate.jobs) {
      j.pinned = false;
      j.assigneeId = null;
      j.startDay = null;
    }
    rEls.modalBackdrop.hidden = true;
    pendingBatch = null;
    renderAll();
    toast(`已一次提交 ${ids.length} 项调整，可撤销。`);
  } catch (err) {
    rstate.jobs = backup; // 全量回退
    rEls.modalBackdrop.hidden = true;
    renderAll();
    toast(`提交失败，已全部回退：${err.message}`, "err");
  }
});

rEls.undo.addEventListener("click", () => {
  const last = rstate.undo.pop();
  if (!last) return;
  rstate.jobs = last.jobs;
  for (const j of rstate.jobs) {
    j.pinned = false;
    j.assigneeId = null;
    j.startDay = null;
  }
  renderAll();
  toast(`已撤销：${last.label}`);
});

/* ---------------- 班表 CSV 导出 ---------------- */

function csvCell(v) {
  return `"${String(v ?? "").replaceAll('"', '""')}"`;
}

rEls.exportBtn.addEventListener("click", () => {
  autoSchedule();
  const analysis = analyze();
  const scheduled = rstate.jobs
    .filter((j) => j.assigneeId && j.startDay != null && !analysis.cycleIds.has(j.id))
    .sort((a, b) => a.startDay - b.startDay || personById(a.assigneeId).name.localeCompare(personById(b.assigneeId).name, "zh"));

  const rows = [["开工日期", "星期", "班次", "班次时段", "负责人员", "岗位", "胶片卷", "片段编号", "损伤类型", "工时(h)", "当日进度", "优先级", "所需设备", "前置依赖", "状态/备注"]];
  for (const j of scheduled) {
    const p = personById(j.assigneeId);
    const detail = jobDamageDetail(j);
    const span = jobSpanDays(j, p);
    const deps = j.deps.map((d) => jobById(d)?.code).filter(Boolean).join("、");
    const conflicted = analysis.conflicts.some((c) => c.jobIds.includes(j.id));
    for (let k = 0; k < span; k++) {
      const iso = addDays(rstate.startDate, j.startDay + k);
      rows.push([
        iso,
        weekday(iso),
        p.shift,
        SHIFTS[p.shift].window,
        p.name,
        p.role,
        reelById(j.reelId)?.name || "",
        j.code,
        detail.list.map((d) => d.label).join("、"),
        detail.hours,
        `第${k + 1}/${span}工作日`,
        j.priority,
        detail.equipLabel || "",
        deps,
        conflicted ? "⚠ 有冲突" : "正常"
      ]);
    }
  }

  let extra = "\n\n未排程 / 冲突任务\n";
  extra += ["片段编号", "胶片卷", "问题"].map(csvCell).join(",") + "\n";
  for (const c of analysis.conflicts) {
    for (const id of c.jobIds) {
      const j = jobById(id);
      if (!j) continue;
      extra += [[j.code], [reelById(j.reelId)?.name || ""], [c.msg]].flat().map(csvCell).join(",") + "\n";
    }
  }

  const body = rows.map((r) => r.map(csvCell).join(",")).join("\n") + extra;
  const blob = new Blob(["﻿" + body], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `修复班表-${rstate.startDate}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
  toast(`已导出 ${scheduled.length} 项排班${analysis.conflicts.length ? `（含 ${analysis.conflicts.length} 项冲突警示）` : ""}。`);
});

/* ---------------- 视图切换 & 启动 ---------------- */

document.querySelectorAll("[data-view-tab]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const target = btn.dataset.viewTab;
    document.querySelectorAll("[data-view-tab]").forEach((b) => b.classList.toggle("active", b === btn));
    $("#viewCheck").hidden = target !== "check";
    $("#viewRepair").hidden = target !== "repair";
  });
});

(function initRepair() {
  renderDamageChecks();
  rEls.startDate.value = rstate.startDate;
  renderAll();
})();

})();
