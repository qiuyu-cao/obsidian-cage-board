"use strict";
const { Plugin, PluginSettingTab, Setting, ItemView, Notice, TFile } = require("obsidian");

const VIEW_TYPE = "cage-board-view";

// ---------------------------------------------------------------- 可配置列定义
const CAGE_COLUMN_DEFS = [
  { key: "mice",       label: "mice",       get: (c) => String(c.mice.length) },
  { key: "purpose",    label: "purpose",    get: (c) => c.fm.purpose || "—" },
  { key: "project",    label: "project",    get: (c) => c.fm.project || "—" },
  { key: "strain",     label: "strain",     get: (c) => c.fm.strain || "—" },
  { key: "water",      label: "water",      get: (c) => c.fm.water || "—" },
  { key: "feed",       label: "feed",       get: (c) => c.fm.feed || "—" },
  { key: "owner",      label: "owner",      get: (c) => c.fm.owner || "—" },
  { key: "special",    label: "special",    get: (c) => c.fm.special || "—" },
  { key: "ntbc",       label: "ntbc",       get: (c) => (/NTBC/.test(c.fm.water || "") ? "💧 NTBC" : "") },
  { key: "note",       label: "note",       get: (c) => c.fm.note || "—" },
  { key: "experiment", label: "experiment", get: (c) => c.fm.experiment || "—" },
];

// 临时编号小鼠：文件名以 T 开头（协议 §1.2；原 provisional 字段已于 2026-10-27 废除）
function isTmpMouse(m) {
  return /^T/.test(m.file.basename);
}

const MOUSE_COLUMN_DEFS = [
  { key: "id",         label: "id",         get: (m) => m.file.basename.split("-")[0] },
  { key: "sex",        label: "sex",        get: (m) => m.fm.sex || "?" },
  { key: "age",        label: "age",        get: (m) => ageWeeks(m.fm.dob) },
  { key: "gt",         label: "gt",         get: (m) => m.fm.genotype || "—" },
  { key: "from",       label: "from",       get: (m) => m.fm.from || "—" },
  { key: "note",       label: "note",       get: (m) => m.fm.note || "—" },
  { key: "status",     label: "status",     get: (m) => m.fm.status || "—" },
  { key: "provisional", label: "临时", get: (m) => (isTmpMouse(m) ? "T" : "") },
];

// Tasks 优先级 emoji -> 名称（与 Tasks 插件 priorityName 一致）
const TASK_PRIORITY = { "🔺": "highest", "⏫": "high", "🔼": "medium", "🔽": "low", "⏬": "lowest" };

// 解析一条任务行（保留原始行文本与行号，供写回时定位）
function parseTaskLine(line, lineNo) {
  const m = line.match(/^([-*]\s+)\[([ xX])\]\s*(.+)$/);
  if (!m) return null;
  const taskText = m[3];
  const dm = taskText.match(/📅\s*(\d{4}-\d{2}-\d{2})/);
  const dm2 = taskText.match(/✅\s*(\d{4}-\d{2}-\d{2})/);
  const pm = taskText.match(/([🔺⏫🔼🔽⏬])/u);
  const textClean = taskText
    .replace(/📅\s*\d{4}-\d{2}-\d{2}/, "")
    .replace(/✅\s*\d{4}-\d{2}-\d{2}/, "")
    .trim();
  return {
    done: m[2] !== " ",
    text: textClean,
    date: dm ? dm[1] : (dm2 ? dm2[1] : null),
    due: dm ? dm[1] : null,
    doneDate: dm2 ? dm2[1] : null,
    priority: pm ? TASK_PRIORITY[pm[1]] : null,
    raw: line,      // 原始行（无行尾符），写回时用于校验/回找
    lineNo: lineNo,
  };
}

// 纯文本切换复选框（Tasks 插件不可用时的兜底）
function manualToggleLine(line) {
  return line.replace(/^([-*]\s+)\[([ xX])\]/, (all, pre, mark) => pre + "[" + (mark === " " ? "x" : " ") + "]");
}

// ---------------------------------------------------------------- 默认设置
const DEFAULT_SETTINGS = {
  includeOffline: false,       // 包含下线笼位
  hideEmpty: false,            // 隐藏零鼠笼
  groupByRack: true,           // 按架分组
  sortBy: "pos",               // pos | name | mice
  density: "normal",           // compact | normal | roomy
  columns: "auto",             // auto | 2 | 3 | 4
  cageColumns: ["mice", "purpose", "project", "water", "feed", "experiment"],
  mouseColumns: ["id", "sex", "age", "gt", "from", "note"],
  timelineMode: "all",         // open | all
  timelineLimit: 10,
  timelineShowDate: true,
  autoRefresh: true,
  autoOpenOnLoad: false,      // 加载后自动打开看板（默认关闭，避免侵入式占用侧栏）
  searchFields: [],           // 搜索检索域（[] = 全部）
};

// ---------------------------------------------------------------- 工具函数
function ageWeeks(dob) {
  if (!dob) return "—";
  const d = new Date(dob);
  if (isNaN(d.getTime())) return "—";
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days < 0) return "—";
  return Math.floor(days / 7) + "w";
}

function toTags(tags) {
  if (Array.isArray(tags)) return tags;
  if (typeof tags === "string") return [tags];
  return [];
}

// frontmatter 值 -> 可搜索文本（数组拼接、对象 JSON、链接保留原文）
function fmValueText(v) {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.map(fmValueText).join(" ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function fmtDate(d) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

// Tasks 风格相对日期标签（与 Tasks 插件 data-task-due 取值一致）：today / past-Nd / future-Nd / past-far / future-far
function relDue(dateStr, now) {
  if (!dateStr) return "";
  const d = new Date(dateStr + "T00:00:00");
  if (isNaN(d.getTime())) return "";
  const t0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diff = Math.round((t0 - d) / 86400000);
  if (diff === 0) return "today";
  const mag = Math.abs(diff) <= 7 ? Math.abs(diff) + "d" : "far";
  return (diff > 0 ? "past-" : "future-") + mag;
}

// 卡片边框底色：仅看「未完成且带 📅 到期日」的任务，优先级 逾期 > 今天 > 明天
// 逾期 → cb-card-due-overdue（红）／今天 → cb-card-due-today（绿）／明天 → cb-card-due-tomorrow（橘黄）
function cardDueClass(tasks, now) {
  const today = fmtDate(now);
  const tomorrow = fmtDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
  let overdue = false, todayHit = false, tomorrowHit = false;
  for (const t of tasks) {
    if (t.done || !t.due) continue;
    if (t.due < today) overdue = true;            // YYYY-MM-DD 可直接按字符串比较
    else if (t.due === today) todayHit = true;
    else if (t.due === tomorrow) tomorrowHit = true;
  }
  if (overdue) return "cb-card-due-overdue";
  if (todayHit) return "cb-card-due-today";
  if (tomorrowHit) return "cb-card-due-tomorrow";
  return "";
}

// 把文本中的 [[wikilink|alias]] 渲染为 internal-link 锚点（配合 Obsidian 页面预览实现悬停弹出）
// 支持：别名（|）、小标题/块引用（#，整体保留在 data-href）、嵌入语法（![[...]] 按普通链接渲染）、纯文本混排
function appendLinkedText(parent, text) {
  const src = text === null || text === undefined ? "" : String(text);
  const re = /!?\[\[([^\]|]+?)(?:\|([^\]]*))?\]\]/g;
  let last = 0;
  let m;
  while ((m = re.exec(src))) {
    if (m.index > last) parent.createSpan({ text: src.slice(last, m.index) });
    const target = m[1].trim();
    const label = (m[2] || "").trim() || target;
    if (target) parent.createEl("a", { cls: "internal-link", attr: { "data-href": target }, text: label });
    else parent.createSpan({ text: label });
    last = m.index + m[0].length;
  }
  if (last < src.length) parent.createSpan({ text: src.slice(last) });
}

// 让元素可拖拽：拖到编辑器（或 Canvas）时落下 [[wikilink]] 文本，实现「拖名字建链接」
function enableLinkDrag(el, linktext) {
  if (!el || !linktext) return el;
  el.draggable = true;
  el.addEventListener("dragstart", (evt) => {
    const dt = evt.dataTransfer;
    if (!dt) return;
    try {
      dt.setData("text/plain", "[[" + linktext + "]]");
      dt.effectAllowed = "copy";
    } catch (e) {
      console.error("cage-board: 拖拽数据写入失败", e);
    }
  });
  return el;
}

// 按未完成任务的 📅 到期日给笼位分类：
//   overdue = 有早于今天的到期任务；today = 有正好今天的到期任务；
//   recent  = 逾期 ∪ 到期日落在今天起 7 天内（含今天/明天）
function classifyCage(tasks, now) {
  const today = fmtDate(now);
  const in7 = fmtDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7));
  let overdue = false, todayHit = false, within7 = false;
  for (const t of tasks) {
    if (t.done || !t.due) continue;
    if (t.due < today) overdue = true;             // YYYY-MM-DD 可直接按字符串比较
    else if (t.due === today) todayHit = true;
    if (t.due >= today && t.due <= in7) within7 = true;
  }
  return { overdue, today: todayHit, recent: overdue || todayHit || within7 };
}

// ---------------------------------------------------------------- 看板视图
class CageBoardView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.contentCache = new Map(); // file.path -> 正文文本（Timeline 解析用）
    this.debounceTimer = null;
    this.resultsTimer = null;
    this.searchKeyword = "";
    this.searchMenuEl = null;
    this.searchBtnEl = null;
    this.searchCountEl = null;
    this.resultsSeq = 0;
    this.filterMode = "all";     // all | today | overdue | recent | project
    this.filterProject = null;   // filterMode = "project" 时的项目键（"" = 未归属）
    this.projBtnEl = null;
    this.projMenuEl = null;
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return "笼位看板"; }
  getIcon() { return "container"; }

  async onOpen() {
    this.rootEl = this.contentEl.createDiv({ cls: "cage-board-root" });
    await this.render();
    // 数据变化自动刷新
    this.registerEvent(this.app.metadataCache.on("changed", () => this.scheduleRender()));
    this.registerEvent(this.app.vault.on("modify", (file) => { this.contentCache.delete(file.path); this.scheduleRender(); }));
    this.registerEvent(this.app.vault.on("delete", (file) => { this.contentCache.delete(file.path); this.scheduleRender(); }));
    this.registerEvent(this.app.vault.on("create", () => this.scheduleRender()));
    // 内部链接接管：自定义视图里 Obsidian 不会自动处理，需自行触发
    // 点击 -> openLinkText（Ctrl/Shift 新开页签）；悬停 -> 触发 hover-link 事件，「页面预览」插件据此弹出预览
    this.registerDomEvent(this.contentEl, "click", (evt) => {
      const a = evt.target instanceof Element ? evt.target.closest("a.internal-link") : null;
      if (!a) return;
      evt.preventDefault();
      const linktext = a.getAttribute("data-href") || "";
      if (linktext) this.app.workspace.openLinkText(linktext, "", evt.ctrlKey || evt.metaKey || evt.shiftKey);
    });
    this.registerDomEvent(this.contentEl, "mouseover", (evt) => {
      const a = evt.target instanceof Element ? evt.target.closest("a.internal-link") : null;
      if (!a) return;
      const linktext = a.getAttribute("data-href") || "";
      if (linktext) this.app.workspace.trigger("hover-link", { event: evt, source: "cage-board", hoverParent: this, targetEl: a, linktext: linktext, sourcePath: "" });
    });
    // 检索域下拉：点击菜单与按钮以外的区域时关闭（视图生命周期内只注册一次）
    this.registerDomEvent(document, "click", (evt) => {
      const menu = this.searchMenuEl, btn = this.searchBtnEl;
      if (menu && btn && !menu.contains(evt.target) && !btn.contains(evt.target)) menu.removeClass("cb-open");
      const pm = this.projMenuEl, pb = this.projBtnEl;
      if (pm && pb && !pm.contains(evt.target) && !pb.contains(evt.target)) pm.removeClass("cb-open");
    });
  }

  onClose() {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.resultsTimer) clearTimeout(this.resultsTimer);
  }

  scheduleRender() {
    if (!this.plugin.settings.autoRefresh) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => { this.render(); }, 300);
  }

  // 搜索输入触发的局部刷新：只重渲染结果区，保持输入框焦点与下拉状态
  scheduleResultsRender() {
    if (this.resultsTimer) clearTimeout(this.resultsTimer);
    this.resultsTimer = setTimeout(() => { this.resultsTimer = null; this.renderResults(); }, 180);
  }

  // 检索域清单：内置 name / mice + 全部笼位 frontmatter key 的并集
  discoverSearchFields() {
    const keys = new Set();
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (!f.path.startsWith("02_Areas/cages/")) continue;
      const cache = this.app.metadataCache.getFileCache(f);
      const fm = (cache && cache.frontmatter) || {};
      if (!toTags(fm.tags).includes("cage")) continue;
      for (const k of Object.keys(fm)) keys.add(k);
    }
    return ["name", "mice"].concat([...keys].sort((a, b) => a.localeCompare(b)));
  }

  // cage 在某个检索域下的可搜索文本
  searchFieldText(cage, key) {
    if (key === "name") return cage.file.basename;
    if (key === "mice") return cage.mice.map((m) => m.file.basename + " " + m.file.basename.split("-")[0]).join(" ");
    return fmValueText(cage.fm[key]);
  }

  // 关键词匹配：空格分隔多个词（AND），任一选中域命中（OR）即算匹配；大小写不敏感
  matchCage(cage, tokens, allFields) {
    const sel = this.plugin.settings.searchFields;
    const fields = sel && sel.length ? sel.filter((k) => allFields.includes(k)) : allFields;
    for (const tok of tokens) {
      let hit = false;
      for (const f of fields) {
        const v = this.searchFieldText(cage, f);
        if (v && v.toLowerCase().includes(tok)) { hit = true; break; }
      }
      if (!hit) return false;
    }
    return true;
  }

  // 搜索栏：检索域下拉（复选）+ 关键词输入 + 清空 + 命中计数
  renderSearchBar() {
    const s = this.plugin.settings;
    const allFields = this.discoverSearchFields();
    const bar = this.rootEl.createDiv({ cls: "cb-searchbar" });

    const btn = bar.createEl("button", { cls: "cb-search-domains", attr: { type: "button", title: "选择检索域（笼位属性）" } });
    const menu = bar.createDiv({ cls: "cb-search-menu" });
    this.searchBtnEl = btn;
    this.searchMenuEl = menu;
    const setBtnLabel = () => {
      const sel = s.searchFields;
      btn.setText(!sel.length ? "检索域：全部" : "检索域：" + sel.length + " 项");
    };
    setBtnLabel();

    btn.addEventListener("click", () => { menu.toggleClass("cb-open", !menu.hasClass("cb-open")); });

    for (const key of allFields) {
      const label = key === "name" ? "name（笼位名）" : key === "mice" ? "mice（小鼠编号）" : key;
      const opt = menu.createDiv({ cls: "cb-search-option" });
      const cb = opt.createEl("input", { attr: { type: "checkbox" } });
      cb.checked = !s.searchFields.length || s.searchFields.includes(key);
      opt.createSpan({ text: label });
      cb.addEventListener("change", () => {
        const sel0 = s.searchFields.slice();
        let sel;
        if (cb.checked) {
          sel = sel0.includes(key) ? sel0 : sel0.concat(key);
        } else {
          const base = sel0.length ? sel0 : allFields.slice();
          sel = base.filter((k) => k !== key);
          if (sel.length === 0) { new Notice("至少保留一个检索域"); cb.checked = true; return; }
        }
        if (allFields.length > 0 && allFields.every((k) => sel.includes(k))) sel = [];
        s.searchFields = sel;
        this.plugin.saveSettings();
        setBtnLabel();
        this.renderResults();
      });
      opt.addEventListener("click", (evt) => {
        if (evt.target !== cb) { cb.checked = !cb.checked; cb.dispatchEvent(new Event("change")); }
      });
    }

    const input = bar.createEl("input", { cls: "cb-search-input", attr: { type: "search", placeholder: "关键词…（空格分隔多个）", spellcheck: "false" } });
    input.value = this.searchKeyword;
    const apply = () => { this.searchKeyword = input.value; };
    input.addEventListener("input", (evt) => { if (evt.isComposing) return; apply(); this.scheduleResultsRender(); });
    input.addEventListener("compositionend", () => { apply(); this.scheduleResultsRender(); });
    input.addEventListener("keydown", (evt) => {
      if (evt.isComposing || evt.keyCode === 229) return;
      if (evt.key === "Enter") { evt.preventDefault(); apply(); this.renderResults(); }
    });

    const clear = bar.createEl("button", { cls: "cb-search-clear", attr: { type: "button", "aria-label": "清空关键词" } });
    clear.setText("✕");
    clear.addEventListener("click", () => {
      input.value = "";
      this.searchKeyword = "";
      if (this.searchCountEl) this.searchCountEl.setText("");
      this.renderResults();
      input.focus();
    });

    this.searchCountEl = bar.createSpan({ cls: "cb-search-count" });
  }

  openFile(file) {
    if (!file) return;
    const leaf = this.app.workspace.getLeaf(false);
    leaf.openFile(file);
  }

  // 构建 笼位名 -> 小鼠文件列表 的索引（基于内存 frontmatter 缓存，毫秒级）
  buildMouseIndex() {
    const map = new Map();
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (!f.path.startsWith("02_Areas/mice/")) continue;
      const cache = this.app.metadataCache.getFileCache(f);
      const fm = (cache && cache.frontmatter) || {};
      if (!toTags(fm.tags).includes("mouse")) continue;
      const cageStr = String(fm.cage || "").trim();
      const m = cageStr.match(/\[\[([^|#]+)(?:\|[^\]]+)?\]\]/);
      const cageName = m ? m[1].trim() : cageStr;
      if (!cageName) continue;
      if (!map.has(cageName)) map.set(cageName, []);
      map.get(cageName).push({ file: f, fm });
    }
    return map;
  }

  // 解析笼位正文的 ## Timeline 段落中的任务行
  async getTimeline(file) {
    let text = this.contentCache.get(file.path);
    if (text === undefined) {
      text = await this.app.vault.cachedRead(file);
      this.contentCache.set(file.path, text);
    }
    const lines = text.split(/\r?\n/); // 去掉行尾符，行号与写回时一致
    const tasks = [];
    let inTimeline = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const head = line.match(/^#{1,6}\s+(.+)$/);
      if (head) {
        if (head[1].trim().toLowerCase() === "timeline") { inTimeline = true; continue; }
        if (inTimeline) break;
        continue;
      }
      if (!inTimeline) continue;
      const t = parseTaskLine(line, i);
      if (t) tasks.push(t);
    }
    return tasks;
  }

  // 用 Tasks 插件 API 切换一行任务（✅ 完成日期、循环任务等规则全部交给 Tasks）
  toggleLine(line, file, want) {
    const tp = this.app.plugins && this.app.plugins.plugins && this.app.plugins.plugins["obsidian-tasks-plugin"];
    const api = tp && tp.apiV1;
    let out = null;
    if (api && typeof api.executeToggleTaskDoneCommand === "function") {
      try {
        out = api.executeToggleTaskDoneCommand(line, file.path);
      } catch (e) {
        console.error("cage-board: Tasks API 调用失败，改用兜底切换", e);
      }
    }
    if (typeof out !== "string" || !out) return manualToggleLine(line);
    const t = parseTaskLine(out, 0);
    return t && t.done === want ? out : manualToggleLine(line);
  }

  // 定位任务行：优先「行号 + 原文」校验，内容已变化时在 Timeline 段内回找原文
  findTaskLine(lines, task) {
    if (task.lineNo >= 0 && task.lineNo < lines.length && lines[task.lineNo] === task.raw) return task.lineNo;
    let inTimeline = false;
    for (let i = 0; i < lines.length; i++) {
      const head = lines[i].match(/^#{1,6}\s+(.+)$/);
      if (head) { inTimeline = head[1].trim().toLowerCase() === "timeline"; continue; }
      if (inTimeline && lines[i] === task.raw) return i;
    }
    return -1;
  }

  // 把勾选结果写回笼位笔记；成功返回新的任务对象，失败返回 null
  async toggleTask(file, task, want) {
    let newLine = null;
    const rewrite = (data) => {
      const crlf = /\r\n/.test(data);
      const lines = data.split(/\r?\n/);
      const idx = this.findTaskLine(lines, task);
      if (idx < 0) return data;
      const toggled = this.toggleLine(lines[idx], file, want);
      if (toggled === lines[idx]) return data;
      lines[idx] = toggled;
      newLine = toggled;
      return lines.join(crlf ? "\r\n" : "\n");
    };
    if (typeof this.app.vault.process === "function") {
      await this.app.vault.process(file, rewrite);
    } else {
      const before = await this.app.vault.read(file);
      const after = rewrite(before);
      if (after !== before) await this.app.vault.modify(file, after);
    }
    if (!newLine) {
      new Notice("未找到该任务行（笔记可能已被修改），请刷新看板后重试");
      return null;
    }
    this.contentCache.delete(file.path);
    return parseTaskLine(newLine, task.lineNo);
  }

  // 生成一条 Timeline 任务 DOM；复选框可点击并写回笔记
  createTaskItem(ul, t, file, now, s) {
    const li = ul.createEl("li", { cls: "task-list-item" + (t.done ? " is-checked" : "") });
    // 与 Tasks 插件一致的 data 属性（主题/片段可直接复用其样式）
    if (t.priority) li.setAttribute("data-task-priority", t.priority);
    const rd = relDue(t.due, now);
    if (rd) li.setAttribute("data-task-due", rd);
    const rdd = relDue(t.doneDate, now);
    if (rdd) li.setAttribute("data-task-done", rdd);
    const box = li.createEl("input", { attr: { type: "checkbox", class: "task-list-item-checkbox" } });
    box.checked = t.done;
    box.setAttribute("aria-label", t.done ? "取消完成" : "标记完成");
    box.addEventListener("click", (evt) => evt.stopPropagation());
    box.addEventListener("change", async () => {
      const want = box.checked;
      box.disabled = true;
      try {
        const nt = await this.toggleTask(file, t, want);
        if (!nt) { box.checked = t.done; return; }
        // 就地替换该条任务，保持其余卡片与滚动位置不变
        li.replaceWith(this.createTaskItem(ul, nt, file, new Date(), this.plugin.settings));
      } catch (e) {
        console.error("cage-board: 写回 Timeline 失败", e);
        box.checked = t.done;
        new Notice("写回 Timeline 失败：" + (e && e.message ? e.message : String(e)));
      } finally {
        if (box.isConnected) box.disabled = false;
      }
    });
    const span = li.createSpan({ cls: "cb-task-text task-description" });
    appendLinkedText(span, t.text);
    if (s.timelineShowDate) {
      if (t.due) li.createSpan({ cls: "cb-task-date task-due", text: "📅 " + t.due });
      if (t.doneDate) li.createSpan({ cls: "cb-task-date task-done", text: "✅ " + t.doneDate });
    }
    return li;
  }

  async buildCard(cage, gridEl) {
    const s = this.plugin.settings;

    // 先解析 Timeline：显示用 + 到期染色用（renderResults 已预计算时直接复用）
    const tasks = cage.tasks || await this.getTimeline(cage.file);
    const now = new Date();

    const card = gridEl.createDiv({ cls: "cb-card" });
    const dueCls = cardDueClass(tasks, now);
    if (dueCls) card.addClass(dueCls);

    // ① 卡片名 + 徽章（点击跳转笼位笔记）
    const head = card.createDiv({ cls: "cb-card-head" });
    const titleA = head.createEl("a", {
      cls: "cb-card-title internal-link",
      attr: { "data-href": cage.file.basename, "data-path": cage.file.path },
      text: cage.file.basename,
    });
    enableLinkDrag(titleA, cage.file.basename); // 拖标题 -> 笔记里落下 [[笼位名]]
    if (cage.mice.length > 0) head.createSpan({ cls: "cb-badge cb-badge-mice", text: "🐭 " + cage.mice.length });
    if (cage.fm.purpose) {
      const pb = head.createSpan({ cls: "cb-badge cb-badge-purpose" });
      appendLinkedText(pb, fmValueText(cage.fm.purpose));
    }
    const status = cage.fm.status || "在线";
    head.createSpan({ cls: "cb-badge cb-badge-status-" + (status === "在线" ? "online" : "offline"), text: status });
    head.addEventListener("click", (e) => { if (e.target.closest("a.internal-link")) return; this.openFile(cage.file); });

    // ② properties（可配置列，标签 = frontmatter 原始 key；project 行兼作投放目标）
    const defs = CAGE_COLUMN_DEFS.filter((d) => s.cageColumns.includes(d.key));
    if (defs.length > 0) {
      const grid = card.createDiv({ cls: "cb-props" });
      for (const d of defs) {
        const value = fmValueText(d.get(cage));
        if (!value) continue;
        const labelEl = grid.createDiv({ cls: "cb-prop-label", text: d.label });
        // frontmatter 里的 [[wikilink]] 渲染成可点击链接（点击/悬停预览走 contentEl 上的事件委托）
        const valueEl = grid.createDiv({ cls: "cb-prop-value" });
        appendLinkedText(valueEl, value);
        // project 列：把任意笔记拖上来即写入 project: "[[笔记名]]"；有值时右端给一个 × 清空
        if (d.key === "project") {
          this.enableProjectDrop(labelEl, valueEl, cage.file);
          if (cage.fm.project) this.addProjectClearBtn(valueEl, cage.file);
        }
      }
    }

    // ③ 笼位小鼠（仿原生数据库表格样式）
    const mdefs = MOUSE_COLUMN_DEFS.filter((d) => s.mouseColumns.includes(d.key));
    if (s.mouseColumns.length > 0 && cage.mice.length > 0 && mdefs.length > 0) {
      card.createDiv({ cls: "cb-section-title", text: "笼位小鼠" });
      const wrap = card.createDiv({ cls: "cb-mice-wrap" });
      const table = wrap.createEl("table", { cls: "cb-mice-table" });
      const thead = table.createEl("thead");
      const hrow = thead.createEl("tr");
      for (const d of mdefs) hrow.createEl("th", { text: d.label });
      const tbody = table.createEl("tbody");
      for (const m of cage.mice) {
        const trow = tbody.createEl("tr", { cls: isTmpMouse(m) ? "cb-mouse-prov" : "" });
        for (const d of mdefs) {
          const td = trow.createEl("td");
          if (d.key === "id") {
            td.addClass("cb-mouse-id");
            const idA = td.createEl("a", { cls: "internal-link", attr: { "data-href": m.file.basename, "data-path": m.file.path }, text: d.get(m) });
            enableLinkDrag(idA, m.file.basename); // 拖小鼠编号 -> 笔记里落下 [[小鼠笔记名]]
          } else {
            appendLinkedText(td, fmValueText(d.get(m)));
          }
        }
        trow.addEventListener("click", (e) => { if (e.target.closest("a.internal-link")) return; this.openFile(m.file); });
      }
    } else if (cage.mice.length === 0) {
      card.createDiv({ cls: "cb-empty-mice", text: "暂无小鼠（零鼠笼）" });
    }

    // ④ Timeline（原生 list 样式：ul > li.task-list-item + checkbox；有任务即显示模块）
    if (tasks.length > 0) {
      const shown = tasks.filter((t) => s.timelineMode === "all" || !t.done).slice(0, s.timelineLimit);
      card.createDiv({ cls: "cb-section-title", text: "Timeline" });
      const tl = card.createDiv({ cls: "cb-timeline" });
      if (shown.length === 0) {
        tl.createDiv({ cls: "cb-task-more", text: "全部任务已完成 ✓" });
      } else {
        const ul = tl.createEl("ul", { cls: "contains-task-list" });
        for (const t of shown) this.createTaskItem(ul, t, cage.file, now, s);
        if (tasks.length > shown.length) {
          tl.createDiv({ cls: "cb-task-more", text: "…还有 " + (tasks.length - shown.length) + " 条任务" });
        }
      }
    }
  }

  // ------------------------------------------------------------ project 拖拽填写
  // 把「标签 + 值」两格都做成投放目标（整行可拖放），拖动中高亮
  enableProjectDrop(labelEl, valueEl, cageFile) {
    const els = [labelEl, valueEl].filter(Boolean);
    if (els.length === 0) return;
    for (const el of els) el.setAttr("title", "把项目笔记拖到这里，自动写入 project: [[笔记名]]");
    const setHover = (on) => { for (const el of els) el.toggleClass("cb-drop-hover", on); };
    for (const el of els) {
      el.addEventListener("dragover", (evt) => {
        if (!evt.dataTransfer) return;
        evt.preventDefault();          // 不阻止默认行为，浏览器就不会派发 drop
        evt.stopPropagation();
        evt.dataTransfer.dropEffect = "link";
        setHover(true);
      });
      el.addEventListener("dragleave", (evt) => {
        if (evt.relatedTarget && els.includes(evt.relatedTarget)) return; // 在两格之间移动不算离开
        setHover(false);
      });
      el.addEventListener("drop", (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        setHover(false);
        this.applyProjectDrop(evt, cageFile);
      });
    }
  }

  async applyProjectDrop(evt, cageFile) {
    const target = this.fileFromDropEvent(evt);
    if (!target) { new Notice("笼位看板：没认出拖进来的笔记"); return; }
    try {
      // 用 Obsidian 自己的链接生成逻辑：跟随「新链接格式」设置，重名时自动带路径
      const link = this.app.fileManager.generateMarkdownLink(target, cageFile.path);
      // processFrontMatter 由 Obsidian 负责 YAML 转义（[[X]] 会被自动加引号）
      await this.app.fileManager.processFrontMatter(cageFile, (fm) => { fm.project = link; });
      new Notice("已写入 " + cageFile.basename + " · project → " + link);
    } catch (e) {
      console.error("cage-board: 写入 project 失败", e);
      new Notice("写入 project 失败：" + (e && e.message ? e.message : String(e)));
    }
  }

  // 从拖拽事件里还原出 vault 内的 TFile：内部拖拽看 text/plain、text/uri-list，外部拖入看 dt.files
  fileFromDropEvent(evt) {
    const dt = evt.dataTransfer;
    if (!dt) return null;
    const texts = [];
    for (const type of ["text/plain", "text/uri-list"]) {
      try { const v = dt.getData(type); if (v) texts.push(v); } catch (e) { /* 无此类型 */ }
    }
    for (const text of texts) {
      const hit = this.fileFromDropText(text);
      if (hit) return hit;
    }
    // 从资源管理器拖入的本地文件：按 vault 根目录换算成相对路径
    if (dt.files && dt.files.length) {
      const adapter = this.app.vault.adapter;
      const base = typeof adapter.getBasePath === "function" ? adapter.getBasePath().replace(/\\/g, "/") : "";
      for (const f of Array.from(dt.files)) {
        const abs = String(f.path || "").replace(/\\/g, "/");
        if (!base || !abs) continue;
        const rel = abs.toLowerCase().startsWith(base.toLowerCase()) ? abs.slice(base.length).replace(/^\/+/, "") : "";
        if (!rel) continue;
        const hit = this.app.vault.getAbstractFileByPath(rel);
        if (hit instanceof TFile) return hit;
      }
    }
    return null;
  }

  fileFromDropText(text) {
    for (const rawLine of String(text).split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      const linktext = this.dropTextToLinktext(line);
      if (!linktext) continue;
      const hit = this.resolveLinktext(linktext);
      if (hit) return hit;
    }
    return null;
  }

  // 把一行拖拽文本归一成「链接文本」（可能是 [[X]]、X、folder/X.md、obsidian://、file:///D:/vault/X.md）
  dropTextToLinktext(line) {
    const wiki = line.match(/!?\[\[([^\]|#]*)(?:[#|][^\]]*)?\]\]/);
    if (wiki) return wiki[1].trim();
    if (/^obsidian:\/\//i.test(line)) {
      try { return decodeURIComponent(new URL(line).searchParams.get("file") || ""); } catch (e) { return ""; }
    }
    if (/^file:\/\//i.test(line)) {
      let p = "";
      try { p = decodeURIComponent(new URL(line).pathname || ""); } catch (e) { return ""; }
      p = p.replace(/\\/g, "/").replace(/^\/+/, "");              // /D:/vault/X.md -> D:/vault/X.md
      const adapter = this.app.vault.adapter;
      const base = typeof adapter.getBasePath === "function" ? adapter.getBasePath().replace(/\\/g, "/") : "";
      if (base && p.toLowerCase().startsWith(base.toLowerCase())) p = p.slice(base.length);
      return p.replace(/^\/+/, "");
    }
    return line.replace(/^["'<]+|["'>]+$/g, "");
  }

  resolveLinktext(text) {
    const t = String(text).replace(/\\/g, "/").replace(/^\.?\//, "").trim();
    if (!t) return null;
    const app = this.app;
    const byPath = app.vault.getAbstractFileByPath(t) || app.vault.getAbstractFileByPath(t + ".md");
    if (byPath instanceof TFile) return byPath;
    const dest = app.metadataCache.getFirstLinkpathDest(t.replace(/\.md$/i, ""), "");
    if (dest) return dest;
    const base = t.split("/").pop().replace(/\.md$/i, "");
    if (base && base !== t) return app.metadataCache.getFirstLinkpathDest(base, "");
    return null;
  }

  // project 有值时，值右端显示 × ：点一下清空该笼位的 project
  addProjectClearBtn(parent, cageFile) {
    const btn = parent.createSpan({ cls: "cb-prop-clear", text: "×" });
    btn.setAttr("aria-label", "清空 project");
    btn.setAttr("title", "清空 project");
    btn.addEventListener("click", (evt) => {
      evt.preventDefault();
      evt.stopPropagation();   // 别触发卡片跳转/拖拽
      this.clearProject(cageFile);
    });
    return btn;
  }

  async clearProject(cageFile) {
    try {
      // 只清值、保留键（模板与协议都是 13 键结构）；null 才会写成空键 project:，"" 会写成 project: ""
      await this.app.fileManager.processFrontMatter(cageFile, (fm) => { fm.project = null; });
      new Notice("已清空 " + cageFile.basename + " · project");
    } catch (e) {
      console.error("cage-board: 清空 project 失败", e);
      new Notice("清空 project 失败：" + (e && e.message ? e.message : String(e)));
    }
  }

  // 从 frontmatter project 提取项目键：[[链接]]/纯文本 → 解析为笔记 basename（同项目不同路径写法归一）；空 = 未归属
  projectKeyOf(cage) {
    const v = fmValueText(cage.fm.project).trim();
    if (!v) return "";
    const m = v.match(/!?\[\[([^\]|]+?)(?:\|[^\]]*)?\]\]/);
    const linktext = (m ? m[1] : v).trim().replace(/\.md$/i, "");
    if (!linktext) return "";
    const hit = this.app.metadataCache.getFirstLinkpathDest(linktext, cage.file.path);
    return hit ? hit.basename : linktext;
  }

  // 筛选按钮行：点击切换下方笼位列表；再点一次回到「全部」
  renderFilterBar(host, cages) {
    const bar = host.createDiv({ cls: "cb-filterbar" });
    const counts = { all: cages.length, today: 0, overdue: 0, recent: 0 };
    const projCounts = new Map();
    for (const c of cages) {
      if (c.cats.today) counts.today++;
      if (c.cats.overdue) counts.overdue++;
      if (c.cats.recent) counts.recent++;
      const pk = c.projKey || "";
      projCounts.set(pk, (projCounts.get(pk) || 0) + 1);
    }

    const chip = (label, mode, count) => {
      const b = bar.createEl("button", { cls: "cb-chip" + (this.filterMode === mode ? " cb-chip-active" : ""), attr: { type: "button" } });
      b.createSpan({ cls: "cb-chip-label", text: label });
      b.createSpan({ cls: "cb-chip-count", text: String(count) });
      b.addEventListener("click", () => {
        this.filterMode = this.filterMode === mode ? "all" : mode;
        this.filterProject = null;
        this.renderResults();
      });
      return b;
    };
    chip("全部", "all", counts.all);
    chip("今天要处理", "today", counts.today);
    chip("逾期", "overdue", counts.overdue);
    chip("最近", "recent", counts.recent);

    // 按项目筛选：点击列出所有项目，选一个项目列出归属它的笼位
    const projLabel = this.filterMode === "project"
      ? (this.filterProject ? "项目：" + this.filterProject : "项目：未归属")
      : "按项目";
    const pb = bar.createEl("button", { cls: "cb-chip" + (this.filterMode === "project" ? " cb-chip-active" : ""), attr: { type: "button", title: "按项目筛选笼位" } });
    pb.createSpan({ cls: "cb-chip-label", text: projLabel });
    pb.createSpan({ cls: "cb-chip-caret", text: "▾" });
    const menu = bar.createDiv({ cls: "cb-proj-menu" });
    this.projBtnEl = pb;
    this.projMenuEl = menu;
    pb.addEventListener("click", (evt) => {
      evt.stopPropagation();
      menu.toggleClass("cb-open", !menu.hasClass("cb-open"));
    });

    const keys = [...projCounts.keys()].sort((a, b) => {
      if (!a) return 1;                    // 未归属 排最后
      if (!b) return -1;
      return a.localeCompare(b);
    });
    for (const key of keys) {
      const opt = menu.createDiv({ cls: "cb-proj-option" });
      if (this.filterMode === "project" && (this.filterProject || "") === key) opt.addClass("cb-proj-active");
      opt.createSpan({ cls: "cb-proj-opt-label", text: key || "（未归属项目）" });
      opt.createSpan({ cls: "cb-chip-count", text: String(projCounts.get(key)) });
      opt.addEventListener("click", () => {
        if (this.filterMode === "project" && (this.filterProject || "") === key) { this.filterMode = "all"; this.filterProject = null; }
        else { this.filterMode = "project"; this.filterProject = key; }
        menu.removeClass("cb-open");
        this.renderResults();
      });
    }
    if (keys.length === 0) menu.createDiv({ cls: "cb-proj-option", text: "暂无项目" });
  }

  async render() {
    this.resultsSeq++;
    this.rootEl.empty();
    this.renderSearchBar();
    await this.renderResults();
  }

  // 结果区渲染（搜索时只调用此函数；每次生成独立容器，过期异步写入落在游离节点上无副作用）
  async renderResults() {
    const seq = ++this.resultsSeq;
    const s = this.plugin.settings;
    for (const el of Array.from(this.rootEl.children)) if (el.hasClass("cb-results")) el.remove();
    const host = this.rootEl.createDiv({ cls: "cb-results" });

    // 小鼠索引（一次性构建）
    const miceByCage = this.buildMouseIndex();

    // 筛出笼位
    let cages = this.app.vault.getMarkdownFiles()
      .filter((f) => f.path.startsWith("02_Areas/cages/"))
      .map((f) => {
        const cache = this.app.metadataCache.getFileCache(f);
        return { file: f, fm: (cache && cache.frontmatter) || {} };
      })
      .filter((c) => toTags(c.fm.tags).includes("cage"));

    if (!s.includeOffline) cages = cages.filter((c) => c.fm.status === "在线");
    cages = cages.map((c) => ({
      ...c,
      mice: (miceByCage.get(c.file.basename) || []).filter((m) => m.fm.status === "在养"),
    }));
    if (s.hideEmpty) cages = cages.filter((c) => c.mice.length > 0);

    // 排序
    cages.sort((a, b) => {
      if (s.sortBy === "mice") return b.mice.length - a.mice.length || a.file.basename.localeCompare(b.file.basename);
      return a.file.basename.localeCompare(b.file.basename);
    });

    // 关键词过滤（计数显示在搜索栏）
    const allFields = this.discoverSearchFields();
    const kw = this.searchKeyword.trim().toLowerCase();
    const tokens = kw ? kw.split(/\s+/) : [];
    const matched = tokens.length ? cages.filter((c) => this.matchCage(c, tokens, allFields)) : cages;
    if (this.searchCountEl) this.searchCountEl.setText(tokens.length ? matched.length + " / " + cages.length : "");

    // 预解析各笼位 Timeline：分类（今天 / 逾期 / 最近）+ 项目键；卡片渲染直接复用
    const now = new Date();
    await Promise.all(matched.map(async (c) => {
      c.tasks = await this.getTimeline(c.file);
      c.cats = classifyCage(c.tasks, now);
      c.projKey = this.projectKeyOf(c);
    }));
    if (seq !== this.resultsSeq) return;

    // 筛选按钮行（原统计行位置）：全部 / 今天要处理 / 逾期 / 最近 / 按项目
    this.renderFilterBar(host, matched);

    // 应用当前筛选
    cages = matched;
    if (this.filterMode === "today") cages = matched.filter((c) => c.cats.today);
    else if (this.filterMode === "overdue") cages = matched.filter((c) => c.cats.overdue);
    else if (this.filterMode === "recent") cages = matched.filter((c) => c.cats.recent);
    else if (this.filterMode === "project") cages = matched.filter((c) => (c.projKey || "") === (this.filterProject || ""));

    if (cages.length === 0) {
      let msg;
      if (this.filterMode === "today") msg = "今天没有要处理的笼位";
      else if (this.filterMode === "overdue") msg = "没有逾期的笼位";
      else if (this.filterMode === "recent") msg = "最近（7 天内 + 逾期）没有需要处理的笼位";
      else if (this.filterMode === "project") msg = this.filterProject ? "项目「" + this.filterProject + "」下没有笼位" : "没有未归属项目的笼位";
      else if (tokens.length) msg = "没有匹配 “" + this.searchKeyword.trim() + "” 的笼位";
      else msg = "没有符合筛选条件的笼位";
      host.createDiv({ cls: "cb-empty", text: msg });
      return;
    }

    const applyGrid = (el) => {
      el.addClass("cb-density-" + s.density);
      if (s.columns !== "auto") el.style.gridTemplateColumns = "repeat(" + s.columns + ", minmax(280px, 1fr))";
    };

    // 分组 or 平铺
    if (s.groupByRack) {
      const racks = {};
      for (const c of cages) {
        const rack = c.file.basename[0] || "?";
        if (!racks[rack]) racks[rack] = [];
        racks[rack].push(c);
      }
      const keys = Object.keys(racks).sort((a, b) => a.localeCompare(b));
      for (const rack of keys) {
        if (seq !== this.resultsSeq) return;
        const list = racks[rack];
        const group = host.createDiv({ cls: "cb-rack-group" });
        group.createDiv({ cls: "cb-rack-title", text: "架 " + rack + " · " + list.length + " 笼 · " + list.reduce((n, c) => n + c.mice.length, 0) + " 只鼠" });
        const g = group.createDiv({ cls: "cb-grid" });
        applyGrid(g);
        for (const c of list) { if (seq !== this.resultsSeq) return; await this.buildCard(c, g); }
      }
    } else {
      const grid = host.createDiv({ cls: "cb-grid" });
      applyGrid(grid);
      for (const c of cages) { if (seq !== this.resultsSeq) return; await this.buildCard(c, grid); }
    }
  }
}

// ---------------------------------------------------------------- 设置页
class CageBoardSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    const plugin = this.plugin;
    const s = plugin.settings;
    containerEl.empty();

    new Setting(containerEl).setName("数据范围").setHeading();
    new Setting(containerEl)
      .setName("包含下线笼位")
      .setDesc("关闭则只看 status = 在线 的笼位")
      .addToggle((t) => t.setValue(s.includeOffline).onChange(async (v) => { s.includeOffline = v; await plugin.saveSettings(); plugin.refreshViews(); }));
    new Setting(containerEl)
      .setName("隐藏零鼠笼")
      .setDesc("不显示没有在养小鼠的笼位")
      .addToggle((t) => t.setValue(s.hideEmpty).onChange(async (v) => { s.hideEmpty = v; await plugin.saveSettings(); plugin.refreshViews(); }));

    new Setting(containerEl).setName("布局").setHeading();
    new Setting(containerEl)
      .setName("按架分组")
      .setDesc("按 C / D / E 分组显示；关闭则平铺")
      .addToggle((t) => t.setValue(s.groupByRack).onChange(async (v) => { s.groupByRack = v; await plugin.saveSettings(); plugin.refreshViews(); }));
    new Setting(containerEl)
      .setName("排序")
      .addDropdown((dd) => dd
        .addOption("pos", "按位置（笼位名）")
        .addOption("name", "按名称")
        .addOption("mice", "按鼠数（多→少）")
        .setValue(s.sortBy)
        .onChange(async (v) => { s.sortBy = v; await plugin.saveSettings(); plugin.refreshViews(); }));
    new Setting(containerEl)
      .setName("卡片密度")
      .addDropdown((dd) => dd
        .addOption("compact", "紧凑")
        .addOption("normal", "正常")
        .addOption("roomy", "宽松")
        .setValue(s.density)
        .onChange(async (v) => { s.density = v; await plugin.saveSettings(); plugin.refreshViews(); }));
    new Setting(containerEl)
      .setName("桌面每行列数")
      .setDesc("手机始终单列")
      .addDropdown((dd) => dd
        .addOption("auto", "自适应")
        .addOption("2", "2 列")
        .addOption("3", "3 列")
        .addOption("4", "4 列")
        .setValue(s.columns)
        .onChange(async (v) => { s.columns = v; await plugin.saveSettings(); plugin.refreshViews(); }));

    new Setting(containerEl).setName("笼位属性显示列").setHeading();
    for (const def of CAGE_COLUMN_DEFS) {
      new Setting(containerEl)
        .setName(def.label)
        .addToggle((t) => t.setValue(s.cageColumns.includes(def.key)).onChange(async (v) => {
          if (v) { if (!s.cageColumns.includes(def.key)) s.cageColumns.push(def.key); }
          else { s.cageColumns = s.cageColumns.filter((k) => k !== def.key); }
          await plugin.saveSettings(); plugin.refreshViews();
        }));
    }

    new Setting(containerEl).setName("小鼠显示列").setHeading();
    for (const def of MOUSE_COLUMN_DEFS) {
      new Setting(containerEl)
        .setName(def.label)
        .addToggle((t) => t.setValue(s.mouseColumns.includes(def.key)).onChange(async (v) => {
          if (v) { if (!s.mouseColumns.includes(def.key)) s.mouseColumns.push(def.key); }
          else { s.mouseColumns = s.mouseColumns.filter((k) => k !== def.key); }
          await plugin.saveSettings(); plugin.refreshViews();
        }));
    }

    new Setting(containerEl).setName("Timeline").setHeading();
    new Setting(containerEl)
      .setName("显示范围")
      .addDropdown((dd) => dd
        .addOption("open", "仅未完成任务")
        .addOption("all", "全部任务")
        .setValue(s.timelineMode)
        .onChange(async (v) => { s.timelineMode = v; await plugin.saveSettings(); plugin.refreshViews(); }));
    new Setting(containerEl)
      .setName("条数上限")
      .setDesc("每张卡片最多显示的任务条数")
      .addSlider((sl) => sl.setLimits(1, 20, 1).setValue(s.timelineLimit).onChange(async (v) => { s.timelineLimit = v; await plugin.saveSettings(); plugin.refreshViews(); }));
    new Setting(containerEl)
      .setName("显示日期")
      .addToggle((t) => t.setValue(s.timelineShowDate).onChange(async (v) => { s.timelineShowDate = v; await plugin.saveSettings(); plugin.refreshViews(); }));

    new Setting(containerEl).setName("其他").setHeading();
    new Setting(containerEl)
      .setName("加载后自动打开")
      .setDesc("启动 Obsidian 时自动打开看板（默认关闭）")
      .addToggle((t) => t.setValue(s.autoOpenOnLoad).onChange(async (v) => { s.autoOpenOnLoad = v; await plugin.saveSettings(); }));
    new Setting(containerEl)
      .setName("自动刷新")
      .setDesc("数据变化时自动重渲染看板")
      .addToggle((t) => t.setValue(s.autoRefresh).onChange(async (v) => { s.autoRefresh = v; await plugin.saveSettings(); plugin.refreshViews(); }));
    new Setting(containerEl)
      .setName("立即刷新")
      .addButton((b) => b.setButtonText("刷新看板").onClick(() => { plugin.refreshViews(); new Notice("笼位看板已刷新"); }));
  }
}

// ---------------------------------------------------------------- 插件主类
module.exports = class CageBoardPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    // 悬停预览依赖核心插件「页面预览」（Page preview）。本插件不会擅自更改其开关：
    // 若未开启，仅悬停预览不生效，其余功能正常。详见 README。
    this.registerView(VIEW_TYPE, (leaf) => new CageBoardView(leaf, this));
    this.addRibbonIcon("container", "打开笼位看板", () => this.activateView());
    this.addCommand({ id: "open-board", name: "打开笼位看板", callback: () => this.activateView() });
    this.addSettingTab(new CageBoardSettingTab(this.app, this));
    // 仅当用户开启「加载后自动打开」时才自动弹出看板（默认关闭，避免侵入式占用侧栏）
    if (this.settings.autoOpenOnLoad) {
      this.app.workspace.onLayoutReady(() => {
        setTimeout(() => { this.activateView(); }, 300);
      });
    }
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getRightLeaf(false);
    if (!leaf) leaf = workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    workspace.revealLeaf(leaf);
  }

  refreshViews() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      const view = leaf.view;
      if (view && typeof view.scheduleRender === "function") view.scheduleRender();
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
};
