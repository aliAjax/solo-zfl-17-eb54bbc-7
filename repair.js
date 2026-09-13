(function () {
"use strict";
/* 离线修复调度台 —— 纯前端，无网络依赖
 * 数据：胶片卷 / 修复任务（可含多项损伤）/ 班次人员 / 设备，全部存 localStorage。
 * 模型：每项损伤 = 一道工序步骤，各自带岗位、工时、设备；同一任务的步骤按固定工序顺序执行，
 *       跨任务依赖挂在「前置任务末步骤 → 本任务首步骤」。所有步骤的人员与设备都参与排程与冲突检查。
 * 排程：步骤级拓扑 + 优先级 + 班次工时 + 人员/设备占用求最早可行日。
 * 门禁：人员重叠、设备重叠、工序/依赖倒置或未排、成环、缺岗、步骤未排均为冲突，有冲突不能保存。
 */

const REPAIR_STORAGE_KEY = "zfl17-film-repair-desk-v2";

const SHIFTS = {
  早班: { label: "早班", hours: 8, window: "09:00–18:00" },
  晚班: { label: "晚班", hours: 6, window: "18:00–24:00" }
};

const ROLES = ["放映员", "修复师", "资料管理员"];
const PRIORITY_RANK = { 高: 0, 中: 1, 低: 2 };

/* 损伤类型字典：决定工序顺序(order)、负责岗位、默认工时、所需设备、基础风险 */
const DAMAGE_TYPES = [
  { key: "dust", order: 1, label: "灰尘霉斑清洁", short: "清洁", role: "资料管理员", hours: 2, equip: "清洁台", risk: 1 },
  { key: "perf", order: 2, label: "齿孔修补", short: "齿孔", role: "修复师", hours: 4, equip: "接片台", risk: 4 },
  { key: "splice", order: 3, label: "接片松动重接", short: "重接", role: "修复师", hours: 3, equip: "接片台", risk: 3 },
  { key: "scratch", order: 4, label: "划痕打磨", short: "打磨", role: "修复师", hours: 6, equip: "抛光机", risk: 3 },
  { key: "color", order: 5, label: "褪色补色校正", short: "补色", role: "修复师", hours: 8, equip: "数字校色台", risk: 4 },
  { key: "screen", order: 6, label: "修复后放映复检", short: "复检", role: "放映员", hours: 2, equip: "放映机", risk: 2 },
  { key: "archive", order: 7, label: "入库登记归档", short: "归档", role: "资料管理员", hours: 1, equip: null, risk: 1 }
];
const DAMAGE_MAP = Object.fromEntries(DAMAGE_TYPES.map((d) => [d.key, d]));
/* 任务内工序固定先后：清洁 → 齿孔 → 重接 → 打磨 → 补色 → 复检 → 归档 */
const STEP_ORDER = DAMAGE_TYPES.slice().sort((a, b) => a.order - b.order).map((d) => d.key);

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

/* ---------------- 种子数据：两卷胶片，含多损伤任务与跨卷资源占用 ---------------- */

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
      sched: {} // damageKey -> { assigneeId, startDay, pinned }
    };
    jobs.push(job);
    return job;
  };

  const rA = reels[0].id;
  const rB = reels[1].id;

  const a1 = addJob(rA, "A-006", ["dust"], "中", [], "片段整体积灰，先清洁再检视。");
  const a2 = addJob(rA, "A-006", ["scratch"], "高", [a1.id], "人物近景左侧划痕，需打磨抛光。");
  const a3 = addJob(rA, "A-012", ["perf", "splice"], "高", [a1.id], "齿孔破损且接片松动，同一修复台按工序连续作业。");
  const a4 = addJob(rA, "A-021", ["color"], "中", [], "褪色段落做数字校色。");
  // 混合损伤：清洁 + 放映复检，分属资料管理员与放映员，分别占清洁台与放映机
  const a5 = addJob(rA, "A-030", ["dust", "screen"], "高", [a2.id, a3.id, a4.id], "清洁后必须上放映机复检，两步骤缺一不可。");
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

function migrateJobs(jobs) {
  for (const j of jobs) {
    if (!j.sched || typeof j.sched !== "object") j.sched = {};
    // 丢弃步骤模型之前的任务级排程字段
    delete j.assigneeId;
    delete j.startDay;
    delete j.pinned;
    // 只保留已知工序的排程状态
    for (const key of Object.keys(j.sched)) {
      if (!DAMAGE_MAP[key]) delete j.sched[key];
    }
  }
}

function loadRepairState() {
  const saved = localStorage.getItem(REPAIR_STORAGE_KEY);
  if (!saved) return buildDefaultState();
  try {
    const parsed = JSON.parse(saved);
    if (!parsed || !Array.isArray(parsed.jobs) || !Array.isArray(parsed.people)) return buildDefaultState();
    migrateJobs(parsed.jobs);
    parsed.undo = Array.isArray(parsed.undo) ? parsed.undo : [];
    return parsed;
  } catch {
    return buildDefaultState();
  }
}

let rstate = loadRepairState();
let editingId = null;
const selected = new Set();

/* ---------------- 任务 / 步骤派生 ---------------- */

function jobDamageDetail(job) {
  const list = STEP_ORDER.filter((k) => job.damages.includes(k)).map((k) => DAMAGE_MAP[k]);
  const hours = list.reduce((s, d) => s + d.hours, 0) || 1;
  const roles = [...new Set(list.map((d) => d.role))];
  const equips = [...new Set(list.map((d) => d.equip).filter(Boolean))];
  return { list, hours, roles, equips };
}

/* 一个任务按工序展开为若干步骤 */
function jobSteps(job) {
  return STEP_ORDER.filter((k) => job.damages.includes(k)).map((key, idx) => ({
    job,
    key,
    idx,
    def: DAMAGE_MAP[key]
  }));
}
function allSteps() {
  return rstate.jobs.flatMap((j) => jobSteps(j));
}
function stepState(job, key) {
  return job.sched?.[key] || null;
}
function stepAssigned(job, key) {
  const s = stepState(job, key);
  return !!(s && s.startDay != null && personById(s.assigneeId));
}
function stepSpan(job, key) {
  const s = stepState(job, key);
  const p = s && personById(s.assigneeId);
  const cap = p ? SHIFTS[p.shift]?.hours || 8 : 8;
  return Math.max(1, Math.ceil(DAMAGE_MAP[key].hours / cap));
}
function stepInterval(job, key) {
  if (!stepAssigned(job, key)) return null;
  const s = stepState(job, key);
  return { start: s.startDay, end: s.startDay + stepSpan(job, key) - 1 };
}
/* 步骤的前置：任务内上一道工序；首道工序的前置是各依赖任务的末道工序 */
function stepPreds(job, key) {
  const keys = STEP_ORDER.filter((k) => job.damages.includes(k));
  const idx = keys.indexOf(key);
  const preds = [];
  if (idx > 0) preds.push({ job, key: keys[idx - 1] });
  if (idx === 0) {
    for (const depId of job.deps) {
      const dep = jobById(depId);
      if (!dep) continue;
      const dkeys = STEP_ORDER.filter((k) => dep.damages.includes(k));
      if (dkeys.length) preds.push({ job: dep, key: dkeys[dkeys.length - 1] });
    }
  }
  return preds;
}
function stepLabel(ref) {
  return `${ref.job.code}·${DAMAGE_MAP[ref.key].label}`;
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

/* ---------------- 依赖成环检测（任务级，Kahn 残留即环上节点） ---------------- */

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

/* ---------------- 自动排程（步骤级）：拓扑+优先级，钉住手动步骤，避让人员与设备 ---------------- */

function autoSchedule() {
  const cycleIds = findCycleJobs(rstate.jobs);

  // 未钉住的步骤排程清空，重新求位
  for (const j of rstate.jobs) {
    if (!j.sched) j.sched = {};
    for (const key of STEP_ORDER) {
      if (j.sched[key] && !j.sched[key].pinned) delete j.sched[key];
    }
  }

  const personBusy = new Map();
  const equipBusy = new Map();
  const mark = (map, key, day) => {
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(day);
  };
  const occupy = (job, key) => {
    const s = stepState(job, key);
    const p = personById(s.assigneeId);
    if (!p) return;
    const eq = DAMAGE_MAP[key].equip;
    for (let d = s.startDay; d < s.startDay + stepSpan(job, key); d++) {
      mark(personBusy, p.id, d);
      if (eq) mark(equipBusy, eq, d);
    }
  };

  // 钉住的步骤视为固定占用（即使违反工序/岗位，也先占住，冲突交给 analyze 标出）
  for (const st of allSteps()) {
    if (cycleIds.has(st.job.id)) continue;
    if (stepAssigned(st.job, st.key) && stepState(st.job, st.key).pinned) occupy(st.job, st.key);
  }

  const remaining = allSteps().filter(
    (st) => !cycleIds.has(st.job.id) && !(stepAssigned(st.job, st.key) && stepState(st.job, st.key).pinned)
  );

  const canPlace = (person, job, key, firstDay) => {
    const span = (() => {
      const cap = SHIFTS[person.shift]?.hours || 8;
      return Math.max(1, Math.ceil(DAMAGE_MAP[key].hours / cap));
    })();
    const eq = DAMAGE_MAP[key].equip;
    for (let d = firstDay; d < firstDay + span; d++) {
      if (personBusy.get(person.id)?.has(d)) return false;
      if (eq && equipBusy.get(eq)?.has(d)) return false;
    }
    return true;
  };

  let guard = remaining.length * remaining.length + 8;
  let todo = [...remaining];
  while (todo.length && guard-- > 0) {
    const ready = todo.filter((st) =>
      stepPreds(st.job, st.key).every((pr) => !cycleIds.has(pr.job.id) && stepAssigned(pr.job, pr.key))
    );
    if (!ready.length) break; // 前置未排（缺资源）等情况留给冲突面板
    ready.sort(
      (a, b) =>
        PRIORITY_RANK[a.job.priority] - PRIORITY_RANK[b.job.priority] ||
        a.idx - b.idx ||
        a.job.code.localeCompare(b.job.code, "zh")
    );
    const st = ready[0];
    const needRole = st.def.role;
    let earliest = 0;
    for (const pr of stepPreds(st.job, st.key)) {
      const iv = stepInterval(pr.job, pr.key);
      if (iv) earliest = Math.max(earliest, iv.end + 1);
    }

    let best = null;
    for (const person of rstate.people.filter((p) => p.role === needRole)) {
      for (let day = earliest; day < earliest + 60; day++) {
        if (canPlace(person, st.job, st.key, day)) {
          const cap = SHIFTS[person.shift]?.hours || 8;
          const finish = day + Math.max(1, Math.ceil(st.def.hours / cap)) - 1;
          if (!best || finish < best.finish || (finish === best.finish && person.name < best.person.name)) {
            best = { person, day, finish };
          }
          break;
        }
      }
    }
    if (best) {
      st.job.sched[st.key] = { assigneeId: best.person.id, startDay: best.day, pinned: false };
      occupy(st.job, st.key);
    }
    // 无论排上与否都移出队列；排不上的步骤由冲突面板提示
    todo = todo.filter((x) => x !== st);
  }
}

/* ---------------- 步骤级冲突分析 ---------------- */

function analyze() {
  const conflicts = [];
  const cycleIds = findCycleJobs(rstate.jobs);
  const cycleJobs = rstate.jobs.filter((j) => cycleIds.has(j.id));
  if (cycleJobs.length) {
    conflicts.push({
      type: "cycle",
      jobIds: cycleJobs.map((j) => j.id),
      steps: cycleJobs.flatMap((j) => j.damages.map((k) => `${j.id}:${k}`)),
      msg: `依赖成环：${cycleJobs.map((j) => j.code).join(" → ")} 等 ${cycleJobs.length} 项任务互相依赖，全部工序无法开工`
    });
  }

  const overlap = (a, b) => a.start <= b.end && b.start <= a.end;
  const assigned = [];
  for (const st of allSteps()) {
    if (cycleIds.has(st.job.id)) continue;
    const iv = stepInterval(st.job, st.key);
    if (iv) {
      const s = stepState(st.job, st.key);
      assigned.push({ ...st, iv, person: personById(s.assigneeId) });
    }
  }

  // 同一人员不能重叠（步骤之间）
  for (const p of rstate.people) {
    const mine = assigned.filter((a) => a.person?.id === p.id);
    for (let i = 0; i < mine.length; i++) {
      for (let k = i + 1; k < mine.length; k++) {
        if (overlap(mine[i].iv, mine[k].iv)) {
          conflicts.push({
            type: "person",
            jobIds: [mine[i].job.id, mine[k].job.id],
            steps: [`${mine[i].job.id}:${mine[i].key}`, `${mine[k].job.id}:${mine[k].key}`],
            msg: `人员冲突：${p.name}（${p.shift}）同一工作日既做 ${stepLabel(mine[i])} 又做 ${stepLabel(mine[k])}`
          });
        }
      }
    }
  }

  // 同一设备不能重叠（每道工序的设备都要查，非主损伤设备也不漏）
  const byEquip = new Map();
  for (const a of assigned) {
    const eqName = a.def.equip;
    if (!eqName) continue;
    if (!rstate.equipment.some((e) => e.name === eqName)) {
      conflicts.push({
        type: "equip-missing",
        jobIds: [a.job.id],
        steps: [`${a.job.id}:${a.key}`],
        msg: `设备缺失：${stepLabel(a)} 需要的「${eqName}」已被删除`
      });
      continue;
    }
    if (!byEquip.has(eqName)) byEquip.set(eqName, []);
    byEquip.get(eqName).push(a);
  }
  for (const [eqName, list] of byEquip) {
    for (let i = 0; i < list.length; i++) {
      for (let k = i + 1; k < list.length; k++) {
        if (overlap(list[i].iv, list[k].iv)) {
          conflicts.push({
            type: "equipment",
            jobIds: [list[i].job.id, list[k].job.id],
            steps: [`${list[i].job.id}:${list[i].key}`, `${list[k].job.id}:${list[k].key}`],
            msg: `设备冲突：${stepLabel(list[i])} 与 ${stepLabel(list[k])} 同日占用「${eqName}」`
          });
        }
      }
    }
  }

  // 工序顺序 / 跨任务依赖
  for (const st of allSteps()) {
    if (cycleIds.has(st.job.id)) continue;
    const iv = stepInterval(st.job, st.key);
    for (const pr of stepPreds(st.job, st.key)) {
      if (cycleIds.has(pr.job.id)) continue;
      const piv = stepInterval(pr.job, pr.key);
      if (!piv) {
        conflicts.push({
          type: "dependency",
          jobIds: [st.job.id, pr.job.id],
          steps: [`${st.job.id}:${st.key}`, `${pr.job.id}:${pr.key}`],
          msg: `工序未排：${stepLabel(st)} 的前置 ${stepLabel(pr)} 尚未排程（缺岗位或设备窗口）`
        });
      } else if (iv && piv.end >= iv.start) {
        conflicts.push({
          type: "dependency",
          jobIds: [st.job.id, pr.job.id],
          steps: [`${st.job.id}:${st.key}`, `${pr.job.id}:${pr.key}`],
          msg: `工序倒置：${stepLabel(pr)} 尚未完工，${stepLabel(st)} 就已开工`
        });
      }
    }
  }

  // 岗位必须匹配
  for (const a of assigned) {
    if (a.person && a.person.role !== a.def.role) {
      conflicts.push({
        type: "role",
        jobIds: [a.job.id],
        steps: [`${a.job.id}:${a.key}`],
        msg: `岗位不符：${stepLabel(a)} 需要${a.def.role}，却拖给了${a.person.role}${a.person.name}`
      });
    }
  }

  // 环外未排步骤（任一步骤漏排都视为任务未完成）
  for (const st of allSteps()) {
    if (cycleIds.has(st.job.id) || stepAssigned(st.job, st.key)) continue;
    const hasRole = rstate.people.some((p) => p.role === st.def.role);
    conflicts.push({
      type: "unassigned",
      jobIds: [st.job.id],
      steps: [`${st.job.id}:${st.key}`],
      msg: hasRole
        ? `工序未能排程：${stepLabel(st)} 在现有班次与「${st.def.equip || "无设备"}」占用下找不到可行窗口（可手动拖入班次格）`
        : `工序未能排程：${stepLabel(st)} 需要${st.def.role}，当前没有该岗位人员`
    });
  }

  const makespan = assigned.reduce((m, a) => Math.max(m, a.iv.end + 1), 0);

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
    `其他冲突与工序漏排 ${soft} 项 ×8`,
    `计划工期 ${makespan} 个工作日 ×2`
  ];

  const conflictSteps = new Set(conflicts.flatMap((c) => c.steps || []));
  const conflictJobIds = new Set(conflicts.flatMap((c) => c.jobIds));
  return { conflicts, makespan, risk, riskDrivers, cycleIds, conflictSteps, conflictJobIds };
}

/* ---------------- 持久化：有冲突一律不落盘 ---------------- */

function persist(analysis) {
  if (analysis.conflicts.length > 0) return false;
  localStorage.setItem(REPAIR_STORAGE_KEY, JSON.stringify(rstate));
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
  }, 3600);
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
    if (role !== "all" && !jobDamageDetail(j).roles.includes(role)) return false;
    return true;
  });
}

function renderStats() {
  const stepCount = allSteps().length;
  rEls.statJobs.textContent = `${rstate.jobs.length} 项 / ${stepCount} 道工序`;
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
      `<label class="check"><input type="checkbox" name="fdmg" value="${d.key}"> <span>${esc(d.label)}</span><small>工序${d.order}·${d.role}·${d.hours}h${d.equip ? `·${d.equip}` : ""}</small></label>`
  ).join("");
  rEls.bDamages.innerHTML = DAMAGE_TYPES.map(
    (d) => `<label class="check"><input type="checkbox" name="bdmg" value="${d.key}"> <span>${esc(d.label)}</span></label>`
  ).join("");
  rEls.fDamages.addEventListener("change", syncDerivedFields);
}

function syncDerivedFields() {
  const keys = STEP_ORDER.filter((k) => rEls.fDamages.querySelector(`input[value="${k}"]`)?.checked);
  const list = keys.map((k) => DAMAGE_MAP[k]);
  if (!list.length) {
    rEls.fRole.value = "";
    rEls.fEquip.value = "";
    rEls.fHours.value = "";
    return;
  }
  rEls.fHours.value = list.reduce((s, d) => s + d.hours, 0);
  rEls.fRole.value = [...new Set(list.map((d) => d.role))].join("、");
  rEls.fEquip.value = [...new Set(list.map((d) => d.equip).filter(Boolean))].join("、") || "无专用设备";
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
              const labels = j.damages.map((k) => DAMAGE_MAP[k]?.short).filter(Boolean).join("、");
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
        <button type="button" class="mini" data-del-person="${p.id}" title="删除该人员（其步骤回到待排）">×</button>
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

function renderGantt() {
  const days = Math.max(10, lastAnalysis.makespan + 1);
  const role = rEls.roleView.value;
  const lanes = rstate.people.filter((p) => role === "all" || p.role === role);
  const laneIds = new Set(lanes.map((p) => p.id));

  const head = `
    <div class="gantt-corner">人员 / 工作日</div>
    ${Array.from({ length: days }, (_, d) => {
      const iso = addDays(rstate.startDate, d);
      const weekend = new Date(`${iso}T00:00:00`).getDay() % 6 === 0;
      return `<div class="gantt-day ${weekend ? "weekend" : ""}"><strong>第${d + 1}天</strong><span>${iso.slice(5)} ${weekday(iso)}</span></div>`;
    }).join("")}`;

  const blockCls = (job, key) =>
    `gantt-block pri-${job.priority} ${lastAnalysis.conflictSteps.has(`${job.id}:${key}`) ? "conflict" : ""}`;

  const personRows = lanes
    .map((p) => {
      const cells = Array.from({ length: days }, (_, d) => `<div class="lane-cell" data-cell-day="${d}" data-person="${p.id}"></div>`).join("");
      const blocks = allSteps()
        .filter((st) => {
          const s = stepState(st.job, st.key);
          return s && s.assigneeId === p.id && s.startDay != null;
        })
        .map((st) => {
          const s = stepState(st.job, st.key);
          const span = Math.min(stepSpan(st.job, st.key), days - s.startDay);
          const reel = reelById(st.job.reelId);
          return `<div class="${blockCls(st.job, st.key)}"
            draggable="true" data-job="${st.job.id}" data-step="${st.key}"
            title="${esc(st.job.code)}｜${esc(st.def.label)}｜${st.def.hours}h｜${esc(reel?.name || "")}"
            style="grid-column:${s.startDay + 2} / span ${span}">
            <strong>${esc(st.job.code)}</strong><span>${esc(st.def.short)}</span><em>${st.def.hours}h</em>
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
      const blocks = allSteps()
        .filter((st) => {
          if (st.def.equip !== e.name) return false;
          const s = stepState(st.job, st.key);
          if (!s || s.startDay == null) return false;
          const p = personById(s.assigneeId);
          return role === "all" || laneIds.has(p?.id);
        })
        .map((st) => {
          const s = stepState(st.job, st.key);
          const p = personById(s.assigneeId);
          const span = Math.min(stepSpan(st.job, st.key), days - s.startDay);
          return `<div class="equip-block pri-${st.job.priority} ${lastAnalysis.conflictSteps.has(`${st.job.id}:${st.key}`) ? "conflict" : ""}"
            title="${esc(st.job.code)}｜${esc(st.def.label)}｜${esc(p?.name || "")}"
            style="grid-column:${s.startDay + 2} / span ${span}">
            ${esc(st.job.code)}<b>${esc(st.def.short)}</b><em>${esc(p?.name || "")}</em></div>`;
        })
        .join("");
      return `<div class="lane-name equip-name"><strong>设备：${esc(e.name)}</strong></div><div class="lane equip-lane">${cells}${blocks}</div>`;
    })
    .join("");

  rEls.gantt.style.gridTemplateColumns = `158px repeat(${days}, 84px)`;
  rEls.gantt.innerHTML = head + personRows + eqRows;

  // 待排 / 成环托盘：以步骤为卡片，保证非主损伤步骤也能单独拖入
  const traySteps = allSteps().filter((st) => {
    if (lastAnalysis.cycleIds.has(st.job.id)) return true;
    return !stepAssigned(st.job, st.key);
  });
  rEls.tray.innerHTML =
    traySteps
      .map((st) => {
        const inCycle = lastAnalysis.cycleIds.has(st.job.id);
        return `<div class="tray-card pri-${st.job.priority} ${inCycle ? "cycle" : ""}" draggable="true" data-job="${st.job.id}" data-step="${st.key}">
          <strong>${esc(st.job.code)}</strong>
          <span>${esc(st.def.label)}</span>
          <em>${st.def.hours}h · ${st.def.role}${st.def.equip ? ` · ${esc(st.def.equip)}` : ""}</em>
          ${inCycle ? '<b class="cycle-badge">依赖成环</b>' : '<b class="wait-badge">工序待排</b>'}
        </div>`;
      })
      .join("") || `<p class="empty">所有工序均已排入班次。</p>`;
}

function jobScheduleText(j) {
  const parts = [];
  for (const st of jobSteps(j)) {
    const iv = stepInterval(j, st.key);
    if (iv) {
      const p = personById(stepState(j, st.key).assigneeId);
      parts.push(`${st.def.short}·${p?.name || "?"}·第${stepState(j, st.key).startDay + 1}天`);
    } else {
      parts.push(`${st.def.short}·未排`);
    }
  }
  return parts.join(" → ");
}

function renderJobList() {
  const jobs = visibleJobs();
  rEls.selCount.textContent = selected.size ? `（已选 ${selected.size} 项）` : "";
  rEls.jobList.innerHTML = jobs
    .map((j) => {
      const detail = jobDamageDetail(j);
      const reel = reelById(j.reelId);
      const depNames = j.deps
        .map((id) => jobById(id)?.code)
        .filter(Boolean)
        .join("、");
      const steps = jobSteps(j);
      const allAssigned = steps.every((st) => stepAssigned(j, st.key));
      const inCycle = lastAnalysis.cycleIds.has(j.id);
      const sched = inCycle ? "依赖成环" : allAssigned ? jobScheduleText(j) : "部分工序未排程";
      const equips = detail.equips.map((e) => esc(e)).join("、") || "无专用设备";
      return `
      <article class="job-card ${lastAnalysis.conflictJobIds.has(j.id) ? "conflict" : ""}">
        <label class="job-pick"><input type="checkbox" data-pick="${j.id}" ${selected.has(j.id) ? "checked" : ""}></label>
        <div class="job-body">
          <div class="job-head">
            <strong>${esc(j.code)}</strong>
            <span class="reel-tag">${esc(reel?.name || "未知卷")}</span>
            <span class="prio pri-tag-${j.priority}">${j.priority}</span>
            ${steps.some((st) => stepState(j, st.key)?.pinned) ? '<span class="pin-tag">手动钉住</span>' : ""}
          </div>
          <div class="tag-row">${detail.list.map((d) => `<span class="tag">${esc(d.label)}</span>`).join("")}</div>
          <p class="job-meta">共${detail.hours}h · 岗位 ${detail.roles.map(esc).join("、")} · 设备 ${equips}</p>
          <p class="job-sched">工序排程：${sched}</p>
          ${depNames ? `<p class="job-deps">任务依赖：${esc(depNames)}（其末工序完成后本任务首工序方可开工）</p>` : ""}
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

function conflictTypeLabel(t) {
  return {
    cycle: "依赖成环",
    person: "人员重叠",
    equipment: "设备重叠",
    "equip-missing": "设备缺失",
    dependency: "工序违例",
    role: "岗位不符",
    unassigned: "工序待排"
  }[t] || t;
}

function renderConflicts() {
  rEls.conflictList.innerHTML =
    lastAnalysis.conflicts
      .map(
        (c) => `<div class="conflict-item ct-${c.type}">
          <strong>${conflictTypeLabel(c.type)}</strong><span>${esc(c.msg)}</span></div>`
      )
      .join("") || `<p class="empty">当前排程无冲突，所有工序均可保存或导出班表。</p>`;

  const level = lastAnalysis.risk >= 55 ? "高风险" : lastAnalysis.risk >= 30 ? "中风险" : "低风险";
  rEls.riskBox.innerHTML = `
    <div class="risk-meter r-${lastAnalysis.risk >= 55 ? "high" : lastAnalysis.risk >= 30 ? "mid" : "low"}">
      <strong>${lastAnalysis.risk}</strong><span>${level}</span>
    </div>
    <ul class="risk-drivers">${lastAnalysis.riskDrivers.map((d) => `<li>${esc(d)}</li>`).join("")}</ul>`;
}

function renderBanner() {
  const n = lastAnalysis.conflicts.length;
  if (n) {
    rEls.banner.hidden = false;
    rEls.banner.innerHTML = `⛔ 检测到 <strong>${n}</strong> 项未解决冲突（含人员/设备/工序），排程<strong>不能保存</strong>（刷新将回到上次保存版本）。请拖动工序色块调整，或解除依赖后重排。`;
  } else {
    rEls.banner.hidden = true;
  }
  rEls.saveBtn.disabled = n > 0;
  rEls.saveBtn.title = n > 0 ? "存在未解决冲突，无法保存" : "保存当前排程";
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
  const damageKeys = STEP_ORDER.filter((k) => rEls.fDamages.querySelector(`input[value="${k}"]`)?.checked);
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
    Object.assign(job, payload, { deps, sched: {} }); // 损伤变化后所有工序重新排
    toast("任务已修改，全部工序已重新排程。");
  } else {
    rstate.jobs.push({ id: uid(), ...payload, deps, sched: {} });
    toast("损伤任务已登记，各工序进入排程。");
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
  if (!confirm(`删除人员「${p.name}」？其名下全部工序将回到待排。`)) return;
  for (const j of rstate.jobs) {
    for (const key of Object.keys(j.sched || {})) {
      if (j.sched[key].assigneeId === p.id) delete j.sched[key];
    }
  }
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
    if (!confirm(`删除任务 ${j.code}（含其全部工序）？其他任务对它的依赖会一并清除。`)) return;
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

/* ---------------- 甘特拖拽改派（步骤级） ---------------- */

let dragJobId = null;
let dragStepKey = null;

document.addEventListener("dragstart", (e) => {
  const block = e.target.closest("[data-job][data-step]");
  if (!block || !$("#viewRepair") || $("#viewRepair").hidden) return;
  dragJobId = block.dataset.job;
  dragStepKey = block.dataset.step;
  rEls.gantt.classList.add("drag-mode");
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", `${dragJobId}:${dragStepKey}`);
});
document.addEventListener("dragend", () => {
  dragJobId = null;
  dragStepKey = null;
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
  if (!job || !job.damages.includes(dragStepKey)) return;
  job.sched[dragStepKey] = { assigneeId: cell.dataset.person, startDay: Number(cell.dataset.cellDay), pinned: true };
  renderAll();
  const related = lastAnalysis.conflicts.filter((c) => c.steps?.includes(`${job.id}:${dragStepKey}`));
  toast(
    related.length
      ? `已改派 ${job.code}·${DAMAGE_MAP[dragStepKey].label}，立即发现 ${related.length} 项冲突，解除前不能保存。`
      : `已改派并钉住 ${job.code}·${DAMAGE_MAP[dragStepKey].label}，无冲突。`,
    related.length ? "err" : "ok"
  );
});

/* ---------------- 全自动重排 / 保存 ---------------- */

rEls.autoBtn.addEventListener("click", () => {
  for (const j of rstate.jobs) j.sched = {};
  renderAll();
  toast("已清除全部手动钉住并按工序全自动重排。");
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
  const jobs = rstate.jobs.map((j) => ({
    ...j,
    damages: [...j.damages],
    deps: [...j.deps],
    sched: j.sched ? { ...j.sched } : {}
  }));
  const byId = new Map(jobs.map((j) => [j.id, j]));
  const log = [];
  ids.forEach((id, i) => {
    const job = byId.get(id);
    if (!job) throw new Error(`第 ${i + 1} 步失败：任务已不存在，事务终止。`);
    const dmgText = (keys) => STEP_ORDER.filter((k) => keys.includes(k)).map((k) => DAMAGE_MAP[k].label).join("、");
    const before = field === "priority" ? job.priority : dmgText(job.damages);
    if (field === "priority") {
      if (!PRIORITY_RANK.hasOwnProperty(value.priority)) throw new Error(`第 ${i + 1} 步失败：优先级取值非法。`);
      job.priority = value.priority;
    } else {
      const keys = value.damages;
      if (!keys.length) throw new Error(`第 ${i + 1} 步失败：损伤类型不能为空（${job.code}），事务终止。`);
      if (keys.some((k) => !DAMAGE_MAP[k])) throw new Error(`第 ${i + 1} 步失败：包含未知损伤类型。`);
      job.damages = value.replace ? [...keys] : [...new Set([...job.damages, ...keys])];
    }
    // 被改动的任务，其旧工序排程全部失效，提交后由自动排程重算
    job.sched = {};
    const after = field === "priority" ? job.priority : dmgText(job.damages);
    log.push({ code: job.code, before, after });
  });
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
          damages: STEP_ORDER.filter((k) => rEls.bDamages.querySelector(`input[value="${k}"]`)?.checked),
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
        <p>事务已整体回退：共计划 ${ids.length} 步，<strong>0</strong> 步生效，现有任务、工序排程与冲突状态保持不变。</p>
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
  const beforeSteps = beforeAnalysis.conflictSteps.size;
  const afterSteps = afterAnalysis.conflictSteps.size;
  rEls.modalTitle.textContent = `批量调整影响预览（${ids.length} 项任务）`;
  rEls.modalBody.innerHTML = `
    <div class="preview-grid">
      <div><span>总工期</span><strong>${beforeAnalysis.makespan}天 → ${afterAnalysis.makespan}天</strong><em class="${deltaMake > 0 ? "bad" : deltaMake < 0 ? "good" : ""}">${deltaMake === 0 ? "不变" : `${deltaMake > 0 ? "+" : ""}${deltaMake}天`}</em></div>
      <div><span>风险指数</span><strong>${beforeAnalysis.risk} → ${afterAnalysis.risk}</strong><em class="${deltaRisk > 0 ? "bad" : deltaRisk < 0 ? "good" : ""}">${deltaRisk === 0 ? "不变" : `${deltaRisk > 0 ? "+" : ""}${deltaRisk}`}</em></div>
      <div><span>冲突工序数</span><strong>${beforeSteps} → ${afterSteps}（冲突项 ${beforeAnalysis.conflicts.length} → ${afterAnalysis.conflicts.length}）</strong><em class="${afterAnalysis.conflicts.length ? "bad" : "good"}">${afterAnalysis.conflicts.length ? "提交后需先解冲突才能保存" : "无冲突"}</em></div>
    </div>
    <div class="preview-list">
      <h3>逐任务改动</h3>
      <ul>${result.log.map((l) => `<li><strong>${esc(l.code)}</strong> ${esc(l.before || "—")} → ${esc(l.after)}</li>`).join("")}</ul>
      ${afterAnalysis.conflicts.length ? `<h3>提交后将出现的冲突</h3><ul>${afterAnalysis.conflicts.map((c) => `<li class="bad">${esc(c.msg)}</li>`).join("")}</ul>` : ""}
    </div>
    <p class="hint">确认后 ${ids.length} 项将作为一次事务提交，改动任务的全部工序按新损伤自动重排；任一步失败已在预检中拦截；提交后可用「撤销上次提交」整体还原。</p>`;
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
  // 再次执行真实事务；失败则用备份快照恢复（含各工序原排程）
  const backup = rstate.jobs.map((j) => ({
    ...j,
    damages: [...j.damages],
    deps: [...j.deps],
    sched: j.sched ? { ...j.sched } : {}
  }));
  try {
    const { jobs } = simulateBatch(ids, field, value);
    rstate.undo.push({ label: `批量${field === "priority" ? "改优先级" : "改损伤"} ${ids.length} 项`, jobs: backup });
    if (rstate.undo.length > 10) rstate.undo.shift();
    rstate.jobs = jobs; // 未改动任务的手动钉住步骤保留
    rEls.modalBackdrop.hidden = true;
    pendingBatch = null;
    renderAll();
    toast(`已一次提交 ${ids.length} 项调整，工序已重排，可撤销。`);
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
  rstate.jobs = last.jobs; // 快照含各工序原排程与钉住状态
  renderAll();
  toast(`已撤销：${last.label}`);
});

/* ---------------- 班表 CSV 导出（按工序步骤，逐工作日展开） ---------------- */

function csvCell(v) {
  return `"${String(v ?? "").replaceAll('"', '""')}"`;
}

rEls.exportBtn.addEventListener("click", () => {
  autoSchedule();
  const analysis = analyze();
  const scheduled = allSteps()
    .filter((st) => {
      if (analysis.cycleIds.has(st.job.id)) return false;
      const s = stepState(st.job, st.key);
      return s && s.startDay != null && personById(s.assigneeId);
    })
    .map((st) => ({ st, s: stepState(st.job, st.key) }))
    .sort((a, b) => a.s.startDay - b.s.startDay || personById(a.s.assigneeId).name.localeCompare(personById(b.s.assigneeId).name, "zh"));

  const rows = [["开工日期", "星期", "班次", "班次时段", "负责人员", "岗位", "胶片卷", "片段编号", "工序", "工时(h)", "当日进度", "优先级", "所需设备", "前置工序", "状态/备注"]];
  for (const { st, s } of scheduled) {
    const j = st.job;
    const p = personById(s.assigneeId);
    const span = stepSpan(j, st.key);
    const preds = stepPreds(j, st.key)
      .map((pr) => (pr.job.id === j.id ? DAMAGE_MAP[pr.key].short : `${pr.job.code}·${DAMAGE_MAP[pr.key].short}`))
      .join("、");
    const conflicted = analysis.conflictSteps.has(`${j.id}:${st.key}`);
    for (let k = 0; k < span; k++) {
      const iso = addDays(rstate.startDate, s.startDay + k);
      rows.push([
        iso,
        weekday(iso),
        p.shift,
        SHIFTS[p.shift].window,
        p.name,
        p.role,
        reelById(j.reelId)?.name || "",
        j.code,
        st.def.label,
        st.def.hours,
        `第${k + 1}/${span}工作日`,
        j.priority,
        st.def.equip || "",
        preds,
        conflicted ? "⚠ 有冲突" : "正常"
      ]);
    }
  }

  let extra = "\n\n未排程 / 冲突工序\n";
  extra += ["片段编号", "工序", "胶片卷", "问题"].map(csvCell).join(",") + "\n";
  const seen = new Set();
  for (const c of analysis.conflicts) {
    for (const stepRef of c.steps || []) {
      const [jid, key] = stepRef.split(":");
      const j = jobById(jid);
      if (!j) continue;
      const line = [j.code, DAMAGE_MAP[key]?.label || key, reelById(j.reelId)?.name || "", c.msg].map(csvCell).join(",");
      if (seen.has(line + c.type)) continue;
      seen.add(line + c.type);
      extra += line + "\n";
    }
  }

  const body = rows.map((r) => r.map(csvCell).join(",")).join("\n") + extra;
  const blob = new Blob(["﻿" + body], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `修复班表-${rstate.startDate}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
  toast(`已导出 ${scheduled.length} 道工序排班${analysis.conflicts.length ? `（含 ${analysis.conflicts.length} 项冲突警示）` : ""}。`);
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
