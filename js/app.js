/* app.js — 화면 흐름 + 부트스트랩 (§3). 계통도는 graphview.js(Cytoscape)에 위임 */
(function () {
  "use strict";
  const SAGE = window.SAGE;
  const GV = () => SAGE.GraphView;
  const STORAGE_KEY = "sage.session.v1";

  const state = {
    screen: "start", grade: "고2", subjectId: "확통", unitId: "확통-확률",
    mode: "general", dx: null, selNode: null,
    editMode: false, editTab: "edge", selEdge: null, editPending: null, editMsg: null,
    masteryFilter: ["full", "partial", "weak", "none"], autoLayout: false, collapsed: false, subjectTree: false,
    history: [], histIdx: -1, view: "tree", browse: "tree", detailSubject: null, legendSubj: null
  };
  let graph = null;
  let mountedKind = null;

  /* ---------- DOM helper ---------- */
  function h(tag, attrs, children) {
    const el = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      if (k === "class") el.className = attrs[k];
      else if (k === "style") el.style.cssText = attrs[k];
      else if (k.startsWith("on") && typeof attrs[k] === "function") el[k.toLowerCase()] = attrs[k];
      else if (attrs[k] != null) el.setAttribute(k, attrs[k]);
    }
    // 접근성: 클릭 가능한 div/span은 키보드로도 조작 가능해야 한다 (Tab 포커스 + Enter/Space)
    if (attrs && typeof attrs.onClick === "function" && (tag === "div" || tag === "span")) {
      if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "0");
      if (!el.hasAttribute("role")) el.setAttribute("role", "button");
      el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); attrs.onClick(e); } });
    }
    (children || []).forEach((c) => {
      if (c == null) return;
      el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return el;
  }
  const $app = () => document.getElementById("app");
  // 깔끔한 계통도(트리) 아이콘 — 이모지 대체
  const TREE_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2.5" width="6" height="5" rx="1.2"/><rect x="2.5" y="16.5" width="6" height="5" rx="1.2"/><rect x="15.5" y="16.5" width="6" height="5" rx="1.2"/><path d="M12 7.5V12M5.5 16.5V12h13v4.5"/></svg>';
  function treeIcon() { const el = document.createElement("span"); el.className = "svgi"; el.innerHTML = TREE_SVG; return el; }

  /* ---------- 수식 렌더 (패널 전용, KaTeX) ---------- */
  function escHtml(s) { return (s || "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }
  const SUPM = { "⁰": "0", "¹": "1", "²": "2", "³": "3", "⁴": "4", "⁵": "5", "⁶": "6", "⁷": "7", "⁸": "8", "⁹": "9", "ⁿ": "n", "ⁱ": "i", "ˣ": "x" };
  function toLatex(s) {
    s = s.replace(/([A-Za-z0-9)\]])([⁰¹²³⁴⁵⁶⁷⁸⁹ⁿⁱˣ]+)/g, (m, b, sup) => b + "^{" + [...sup].map((c) => SUPM[c] || c).join("") + "}");
    s = s.replace(/√\(([^)]*)\)/g, "\\sqrt{$1}").replace(/√/g, "\\sqrt{\\ }");
    s = s.replace(/\(([^()]+)\)\/\(([^()]+)\)/g, "\\frac{$1}{$2}");
    s = s.replace(/([^\/\s]+)\/([^\/\s]+)/g, "\\frac{$1}{$2}");
    s = s.replace(/×/g, "\\times ").replace(/−/g, "-");
    return s;
  }
  // 한글 등 비수식 토큰은 그대로, 수식 토큰만 KaTeX로 렌더한 HTML 반환
  function mathHTML(text) {
    if (!text) return "";
    if (typeof katex === "undefined") return escHtml(text);
    return text.split(/(\s+)/).map((tok) => {
      if (/^\s+$/.test(tok)) return tok;
      if (/[가-힣]/.test(tok) || !/[=/√^×⁰¹²³⁴⁵⁶⁷⁸⁹ⁿⁱˣ]/.test(tok)) return escHtml(tok);
      try { return katex.renderToString(toLatex(tok), { throwOnError: false, displayMode: false }); }
      catch (e) { return escHtml(tok); }
    }).join("");
  }
  function hMath(cls, text) { const el = document.createElement("div"); el.className = cls; el.innerHTML = mathHTML(text); return el; }
  function spanMath(cls, text) { const el = document.createElement("span"); el.className = cls; el.innerHTML = mathHTML(text); return el; }

  /* ---------- persistence ---------- */
  function save() {
    if (!state.dx) return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      screen: state.screen, grade: state.grade, subjectId: state.subjectId,
      unitId: state.unitId, mode: state.mode, selNode: state.selNode, dx: state.dx.serialize()
    }));
  }
  function clearSave() { localStorage.removeItem(STORAGE_KEY); }
  function loadSaved() { try { return JSON.parse(localStorage.getItem(STORAGE_KEY)); } catch (e) { return null; } }

  /* ---------- render dispatch ---------- */
  function render() {
    const isWs = state.screen === "map" || state.screen === "result";
    if (isWs) {
      const key = state.view === "overview" ? "ov" : state.view === "tree" ? "tree" : "det:" + state.detailSubject;
      if (mountedKind !== key) {
        if (mountedKind && (mountedKind.indexOf("det:") === 0 || mountedKind === "tree")) GV().unmount();
        if (state.view === "overview") buildOverview();
        else if (state.view === "tree") buildTree();
        else buildWorkspaceShell();
        mountedKind = key;
      }
      if (state.view === "overview") refreshOverview();
      else if (state.view !== "tree") refreshWorkspace();
    } else {
      if (mountedKind && (mountedKind.indexOf("det:") === 0 || mountedKind === "tree")) GV().unmount();
      mountedKind = state.screen;
      const root = $app(); root.innerHTML = "";
      root.appendChild(topBar());
      if (state.screen === "start") root.appendChild(startScreen());
      else if (state.screen === "activity") root.appendChild(activityScreen());
      else if (state.screen === "admin") root.appendChild(adminScreen());
    }
    save();
  }

  /* ---------- top bar ---------- */
  function topBar() {
    if (state.screen === "start") return h("div");
    const sub = graph.node(state.subjectId), unit = graph.node(state.unitId);
    const right = [];
    let progressEl = null;
    if (state.screen === "activity" && state.dx) {
      const p = state.dx.progress();
      right.push(h("span", { class: "step-label" }, [p.index + " / " + p.total]));
      const pct = p.total ? Math.round((p.index / p.total) * 100) : 0;
      progressEl = h("div", { class: "tb-progress" }, [h("div", { class: "tb-progress-fill", style: "width:" + pct + "%" })]);
    }
    return h("div", { class: "topbar" }, [
      h("div", { class: "tb-left" }, [
        h("div", { class: "tb-brand", title: "처음 화면으로", onClick: goHome }, [
          h("div", { class: "tb-title" }, ["성취 진단"])
        ]),
        h("span", { class: "tb-tag" }, [
          state.grade + " · " + sub.name + (state.mode === "general" ? " · " + unit.name : " · 정밀")
        ])
      ]),
      h("div", { class: "tb-right" }, [
        h("div", { class: "tb-home", title: "처음 화면으로", onClick: goHome }, ["⌂ 처음으로"])
      ].concat(right)),
      progressEl
    ]);
  }

  /* ---------- start screen ---------- */
  function unitHasActivity(unitId) { return graph.standardsInUnit(unitId).some((n) => graph.activityFor(n.id)); }
  function unitsWithActivities(subjId) { return graph.childrenOf(subjId).filter((n) => n.type === "unit" && unitHasActivity(n.id)); }
  function firstUnitOf(subjId) { const withAct = unitsWithActivities(subjId); if (withAct.length) return withAct[0].id; const u = graph.childrenOf(subjId).filter((n) => n.type === "unit"); return u.length ? u[0].id : subjId; }
  function subjectsWithActivities() { return graph.nodesByType("subject").filter((s) => graph.standardsInSubject(s.id).some((n) => graph.activityFor(n.id))); }

  function startScreen() {
    const grades = ["고1", "고2", "고3"];
    const subjects = subjectsWithActivities();
    // 활동이 없는 과목이 선택돼 있으면 진단 가능한 첫 과목으로 보정
    if (subjects.length && !subjects.some((s) => s.id === state.subjectId)) { state.subjectId = subjects[0].id; state.unitId = firstUnitOf(state.subjectId); }
    // 활동(문항)이 준비된 단원만 노출 — 빈 단원 선택 시 '측정 없이 모두 이해' 모순 방지
    const units = unitsWithActivities(state.subjectId);
    if (units.length && !units.some((u) => u.id === state.unitId)) state.unitId = units[0].id;
    const saved = loadSaved();

    const gradeRow = h("div", { class: "chip-row" }, grades.map((gd) =>
      h("div", { class: "chip" + (state.grade === gd ? " on" : ""), onClick: () => { state.grade = gd; render(); } }, [gd])
    ));
    const modeRow = h("div", { class: "chip-row" }, [
      chip("일반진단", state.mode === "general", () => { state.mode = "general"; render(); }),
      chip("정밀진단", state.mode === "precise", () => { state.mode = "precise"; render(); })
    ]);
    const subjRow = h("div", { class: "chip-row wrap" }, subjects.map((s) =>
      chip(s.name, state.subjectId === s.id, () => { state.subjectId = s.id; state.unitId = firstUnitOf(s.id); render(); })
    ));
    const unitRow = h("div", { class: "chip-row wrap" }, units.map((u) =>
      chip(u.name, state.mode === "general" && state.unitId === u.id, () => { state.unitId = u.id; render(); })
    ));
    if (state.mode === "precise") unitRow.classList.add("dim");

    const modeDesc = state.mode === "general"
      ? "선택한 단원의 최상위 성취기준부터, 막히면 선수개념으로 거슬러 올라갑니다."
      : "이 학년까지 이수했어야 할 모든 단원의 최상위 성취기준을 점검합니다.";

    const els = [
      h("div", { class: "hello" }, ["안녕하세요"]),
      h("h1", { class: "h1" }, ["어디까지 배웠는지", h("br"), "알려주세요"]),
      h("p", { class: "lead" }, ["이수한 단원을 고르면, 계통도를 따라 활동으로 이해도를 진단합니다."]),
      label("학년"), gradeRow,
      label("진단 방식"), modeRow,
      label("과목"), subjRow,
      label("단원"), unitRow,
      h("p", { class: "mode-desc" }, [modeDesc]),
      h("div", { class: "btn primary", onClick: startDiagnosis }, ["계통도 보기 →"]),
      h("div", { class: "btn light wide", onClick: () => { state.dx = null; goTree(); } }, ["전체 계통도 둘러보기"])
    ];
    if (saved) els.push(h("div", { class: "resume", onClick: resume }, ["↩︎ 진행 중이던 진단이 있어요. 이어서 하기"]));
    return h("div", { class: "start" }, [
      h("div", { class: "admin-entry", title: "관리자(교사) 계통도 편집", onClick: goAdmin }, ["⚙ 관리자"]),
      h("div", { class: "start-inner" }, els)
    ]);
  }
  function chip(text, on, onClick) { return h("div", { class: "chip" + (on ? " on" : ""), onClick }, [on ? text + " ✓" : text]); }
  function label(t) { return h("div", { class: "field-label" }, [t]); }

  function startDiagnosis() {
    const opts = { mode: state.mode, subjectId: state.subjectId };
    if (state.mode === "general") opts.unitId = state.unitId;   // precise는 과목 전체라 unitId 무시
    state._stp = null;   // 이전 시도의 스텝형 진행이 새 진단에 섞이지 않도록
    state.dx = new SAGE.Diagnosis(graph, opts).start();
    const first = state.dx.current();
    state.selNode = first ? first.standardId : state.selNode;
    // 진단도 기본 계통도(전체 개념 트리)로 진입 — 진단 성취기준을 줌·강조
    state.detailSubject = graph.node(state.unitId) ? graph.node(state.unitId).parent : state.subjectId;
    state.view = "tree"; state.browse = "tree"; state.screen = "map"; render();
  }
  function resume() {
    const saved = loadSaved(); if (!saved) return;
    // 저장 이후 콘텐츠가 개편됐으면 복원하지 않음 — 남은 큐의 성취기준·활동이 전부 유효해야 함
    const q = (saved.dx && saved.dx.queue) || [], ptr = (saved.dx && saved.dx.ptr) || 0;
    const stale = q.slice(ptr).some((id) => !graph.node(id) || !graph.activityFor(id));
    if (stale) { clearSave(); alert("저장된 진단 이후 콘텐츠가 갱신되어 이어할 수 없어요. 새로 시작해 주세요."); render(); return; }
    Object.assign(state, { grade: saved.grade, subjectId: saved.subjectId, unitId: saved.unitId, mode: saved.mode, selNode: saved.selNode });
    state._stp = null;
    state.dx = SAGE.Diagnosis.restore(graph, saved.dx);
    state.screen = saved.screen === "start" ? "map" : saved.screen;
    render();
  }

  /* ---------- workspace (Cytoscape 계통도 + 패널) ---------- */
  /* ---------- 오버뷰: 과목 카드 그리드 (해결 1) ---------- */
  const OV_TIERS = [["중학교", "중학교"], ["공통", "고1 · 공통"], ["기본", "고1 · 기본"], ["일반선택", "고2 · 일반선택"], ["진로선택", "진로 선택"], ["융합선택", "융합 선택"]];
  const APP_TRACK = { "중학교": "#7E8BA3", "공통": "#5B7A5B", "기본": "#A38B6E", "일반선택": "#C08A4A", "진로선택": "#8E7BA3", "융합선택": "#6FA38E" };
  function subjectPct(s) {
    if (!state.dx) return null;
    let sum = 0, cnt = 0;
    graph.standardsInSubject(s.id).forEach((n) => { if (state.dx.results[n.id]) { sum += SAGE.MASTERY[state.dx.masteryOf(n.id)].weight; cnt++; } });
    return cnt ? Math.round(sum / cnt) : null;
  }
  function subjectCard(s) {
    const cnt = graph.standardsInSubject(s.id).length, pct = subjectPct(s);
    return h("div", { class: "ov-card", style: "border-top-color:" + (APP_TRACK[s.track] || "#5B7A5B"), onClick: () => enterDetail(s.id) }, [
      h("div", { class: "ov-card-name" }, [s.name]),
      h("div", { class: "ov-card-meta" }, [cnt + "개 성취기준"]),
      pct != null ? h("div", { class: "ov-card-pct", style: "color:" + (APP_TRACK[s.track] || "#5B7A5B") }, [pct + "% 도달"]) : null
    ]);
  }
  function buildOverview() {
    const root = $app(); root.innerHTML = ""; root.appendChild(topBar());
    const byTrack = {}; graph.nodesByType("subject").forEach((s) => { (byTrack[s.track] = byTrack[s.track] || []).push(s); });
    const sections = [];
    OV_TIERS.forEach((t) => {
      const list = (byTrack[t[0]] || []).sort((a, b) => a.id.localeCompare(b.id));
      if (!list.length) return;
      sections.push(h("div", { class: "ov-tier" }, [
        h("div", { class: "ov-tier-label" }, [t[1]]),
        h("div", { class: "ov-cards" }, list.map(subjectCard))
      ]));
    });
    const head = h("div", { class: "ov-head" }, [
      h("div", { class: "btn primary ov-tree-btn", onClick: goTree }, [treeIcon(), "전체 개념 트리로 보기"]),
      h("div", { class: "ov-title" }, ["또는 과목을 선택해 펼치기"]),
      h("div", { class: "ov-sub" }, [state.dx ? "진단한 과목은 도달도가 표시됩니다 · 카드를 누르면 그 과목 계통도가 열립니다" : "카드를 누르면 그 과목의 성취기준 계통도가 열립니다"])
    ]);
    root.appendChild(h("div", { class: "overview" }, [head, h("div", { class: "ov-body" }, sections)]));
  }
  function refreshOverview() {}
  function enterDetail(subjId) { state.view = "detail"; state.detailSubject = subjId; state.subjectId = subjId; state.unitId = firstUnitOf(subjId); state.subjectTree = true; render(); }
  function goHome() { state.editMode = false; state._enterEdit = false; state.dx = null; state._stp = null; state.screen = "start"; render(); }
  // 관리자(교사) 진입 — 전용 활동 관리 화면 (나중에 URL로 분리 예정)
  function goAdmin() { state.dx = null; state._stp = null; state.editMode = false; state.screen = "admin"; state.adminView = "list"; state.adminAct = null; state._pickOpen = null; render(); }
  // 계통도 편집(선수관계·세부 수행능력) — 관리자 화면에서 진입
  function goAdminGraph() {
    state.dx = null; state.editMode = false; state.subjectTree = true; state.detailSubject = state.subjectId;
    state.view = "detail"; state.browse = "tree"; state.screen = "map"; state._enterEdit = true;
    render();
  }
  function goTree() { state.view = "tree"; state.browse = "tree"; state.screen = "map"; render(); }
  function goCards() { state.view = "overview"; state.browse = "overview"; state.screen = "map"; render(); }
  function backToBrowse() { state.view = state.browse || "tree"; render(); }   // 상세에서 '뒤로' = 마지막 둘러보기(트리/카드)

  const SUBJ_NAME = { "9수": "중학교 수학", "10공수1": "공통수학1", "10공수2": "공통수학2", "12대수": "대수", "12미적Ⅰ": "미적분Ⅰ", "12미적Ⅱ": "미적분Ⅱ", "12기하": "기하", "확통": "확률과 통계" };
  function subjectLegend() {
    const cmap = GV().subjectColors ? GV().subjectColors() : {};
    return h("div", { class: "ct-legend", id: "ctLegend" },
      Object.keys(SUBJ_NAME).map((id) => h("span", {
        class: "ct-leg-item clickable" + (state.legendSubj === id ? " on" : ""), "data-subj": id,
        title: SUBJ_NAME[id] + "만 강조", onClick: () => onLegendClick(id)
      }, [
        h("span", { class: "ct-leg-dot", style: "background:" + (cmap[id] || "#5B7A5B") }), SUBJ_NAME[id]
      ])));
  }
  // 범례 과목 클릭 → 그 과목만 강조(토글). 다시 누르면 해제.
  function onLegendClick(subj) {
    state.legendSubj = (state.legendSubj === subj) ? null : subj;
    GV().highlightSubject(state.legendSubj);
    document.querySelectorAll(".ct-leg-item").forEach((el) =>
      el.classList.toggle("on", el.getAttribute("data-subj") === state.legendSubj));
    setHint(state.legendSubj ? (SUBJ_NAME[state.legendSubj] + " 성취기준만 강조 중 · 다시 누르면 해제") : HINT_VIEW);
  }
  // 전체 개념 흐름 트리 — 190개 성취기준을 선수관계로 이은 한 장의 트리(과목별 색)
  function buildTree() {
    state.legendSubj = null;
    const root = $app(); root.innerHTML = ""; root.appendChild(topBar());
    const cyEl = h("div", { class: "cy", id: "cyTree" });
    const search = h("input", { class: "cy-search", id: "cySearch", type: "text", placeholder: "🔍 성취기준 검색 (Enter)" });
    search.addEventListener("keydown", (e) => { if (e.key === "Enter") searchFocus(search.value); });
    const toolbar = h("div", { class: "cy-toolbar" }, [
      h("div", { class: "tb-group" }, [
        h("div", { class: "ctrl-toggle back", onClick: goCards }, ["▦ 과목 카드"]),
        search
      ]),
      h("div", { class: "tb-group right" }, [
        h("div", { class: "ctrl-toggle", id: "downToggle", onClick: toggleDownstream }, ["후속까지"]),
        h("div", { class: "ctrl-toggle", onClick: () => { GV().relayoutTree(); setTimeout(() => GV().fitAll(), 380); } }, [treeIcon(), "트리 정렬"])
      ])
    ]);
    const zoomCtl = h("div", { class: "cy-zoom" }, [
      ctrlBtn("＋", () => GV().zoomBy(1.25)), ctrlBtn("－", () => GV().zoomBy(0.8)), ctrlBtn("⤢", () => GV().fitAll(), "전체 보기")
    ]);
    const head = h("div", { class: "tree-titles ct-head" }, [
      h("div", { class: "tree-title" }, ["수학 개념 흐름 계통도"]),
      h("div", { class: "tree-sub" }, ["성취기준을 선수관계로 이은 전체 트리 · 노드를 누르면 선행 개념이 거슬러 강조됩니다 · 색 = 과목"])
    ]);
    const canvas = h("div", { class: "canvas" }, [cyEl, zoomCtl, subjectLegend(), h("div", { class: "cy-hint", id: "cyHint" }, [HINT_VIEW])]);
    const main = h("div", { class: "ws-main" }, [toolbar, head, canvas]);
    const panel = h("div", { class: "panel", id: "wpanel" });
    root.appendChild(h("div", { class: "workspace" }, [main, panel]));
    GV().mountConceptTree(cyEl, graph, {
      dx: state.dx, selId: state.selNode, onSelect: onNodeSelect, onEdgeTap: onEdgeTap,
      onReady: () => {
        const cy = GV().cy;
        if (state.selNode && cy && cy.$id(state.selNode).length) { GV().focus(state.selNode); highlightLegend(state.selNode); } // 선택/진단 성취기준으로 줌·강조
        else GV().fitAll();
        renderPanel();
      }
    });
  }

  function buildWorkspaceShell() {
    const root = $app(); root.innerHTML = "";
    root.appendChild(topBar());

    const cyEl = h("div", { class: "cy", id: "cy" });
    const search = h("input", { class: "cy-search", id: "cySearch", type: "text", placeholder: "🔍 성취기준 검색 (Enter)" });
    search.addEventListener("keydown", (e) => { if (e.key === "Enter") searchFocus(search.value); });
    const toggles = [
      h("div", { class: "ctrl-toggle", id: "showAllToggle", onClick: toggleShowAll }, ["전체 선 보기"]),
      h("div", { class: "ctrl-toggle", id: "verifiedToggle", onClick: toggleVerified }, ["검수선만"]),
      h("div", { class: "ctrl-toggle", id: "downToggle", onClick: toggleDownstream }, ["후속까지"]),
      h("div", { class: "ctrl-toggle", id: "keyToggle", onClick: toggleKeyOnly }, ["핵심만"]),
      GV().hasElk && GV().hasElk() ? h("div", { class: "ctrl-toggle", id: "autoLayoutToggle", onClick: toggleAutoLayout }, ["⊞ 자동정렬"]) : null,
      GV().hasTree && GV().hasTree() ? h("div", { class: "ctrl-toggle", id: "treeToggle", onClick: toggleSubjectTree }, ["과목 트리"]) : null,
      state.screen === "map" ? h("div", { class: "ctrl-toggle edit", id: "editToggle", onClick: toggleEdit }, ["✎ 편집 모드"]) : null,
      h("span", { class: "filter-slot", id: "filterSlot" })
    ];
    const toolbar = h("div", { class: "cy-toolbar" }, [
      h("div", { class: "tb-group" }, [
        h("div", { class: "ctrl-toggle back", onClick: backToBrowse }, ["← 전체 보기"]),
        subjectSelect(), search]),
      h("div", { class: "tb-group right" }, toggles)
    ]);
    const zoomCtl = h("div", { class: "cy-zoom" }, [
      h("div", { class: "ctrl-btn disabled", id: "navBack", title: "이전 선택", onClick: goBack }, ["◀"]),
      h("div", { class: "ctrl-btn disabled", id: "navFwd", title: "다음 선택", onClick: goForward }, ["▶"]),
      h("div", { class: "ctrl-sep" }),
      ctrlBtn("＋", () => GV().zoomBy(1.25)), ctrlBtn("－", () => GV().zoomBy(0.8)), ctrlBtn("⤢", () => GV().fitAll(), "전체 보기")
    ]);
    const hint = h("div", { class: "cy-hint", id: "cyHint" }, [HINT_VIEW]);
    const mini = h("div", { class: "cy-mini", id: "cyMini" }, [h("div", { class: "cy-mini-rect" })]);
    const canvas = h("div", { class: "canvas" }, [cyEl, zoomCtl, legendEl(), mini, hint]);
    const main = h("div", { class: "ws-main" }, [toolbar, canvas]);
    const panel = h("div", { class: "panel", id: "wpanel" });
    root.appendChild(h("div", { class: "workspace" }, [main, panel]));

    GV().mount(cyEl, graph, {
      dx: state.dx, selId: state.selNode, onSelect: onNodeSelect, detailSubject: state.detailSubject,
      onStubTap: (subj, prereqId) => focusPrereq(prereqId), onEdgeTap: onEdgeTap,
      onCreateEdge: onCreateEdge, onSelectEdge: onSelectEdge,
      onEditStatus: onEditStatus, onEditClear: onEditClear,
      onReady: () => {
        // 과목 상세도 '선수관계 트리'가 기본 — 단원 배열 대신 트리로 펼침
        if (state.subjectTree !== false && !state.editMode) {
          const ok = GV().runSubjectTree(state.detailSubject);
          if (ok) {
            state.subjectTree = true;
            const t = document.getElementById("treeToggle");
            if (t) { t.classList.add("on"); t.textContent = "단원 배열"; }
            showUnitLegend();
          }
        }
        GV().fitAll();
        const cy = GV().cy;
        if (state._pendingFocus && cy && cy.$id(state._pendingFocus).length) { GV().focus(state._pendingFocus); highlightLegend(state._pendingFocus); state._pendingFocus = null; }
        else if (state.selNode && cy && cy.$id(state.selNode).length) { GV().highlight(state.selNode); highlightLegend(state.selNode); }
        const m = document.getElementById("cyMini"); const r = m && m.querySelector(".cy-mini-rect");
        if (m && r) GV().initMinimap(m, r);
        if (state._enterEdit) { state._enterEdit = false; if (!state.editMode) toggleEdit(); }
      }
    });
  }
  function ctrlBtn(txt, onClick, title) { return h("div", { class: "ctrl-btn", title: title || "", onClick }, [txt]); }

  function legendEl() {
    const M = SAGE.MASTERY;
    const dot = (c, t) => h("span", { class: "lg-item" }, [h("span", { class: "lg-dot", style: "background:" + c }), t]);
    const line = (cls, t) => h("span", { class: "lg-item" }, [h("span", { class: "lg-line " + cls }), t]);
    return h("div", { class: "cy-legend", id: "cyLegend" }, [
      h("div", { class: "lg-row" }, [h("b", {}, ["도달도"]),
        dot(M.full.color, "완전"), dot(M.partial.color, "부분"), dot(M.weak.color, "미흡"), dot(M.none.color, "미평가")]),
      h("div", { class: "lg-row" }, [h("b", {}, ["선"]),
        line("solid", "검수됨"), line("dashed", "초안"), line("green", "직접추가")]),
      h("div", { class: "lg-mode", id: "modeText" }, [colorModeText()])
    ]);
  }
  function colorModeText() {
    if (state.view === "detail" && state.subjectTree) return "● 노드 색 = 단원별";
    return state.dx ? "● 채움 = 과목(학년) · 좌측 띠 = 도달도" : "● 노드 색 = 과목(학년)별";
  }
  // 과목 트리: 좌하단 범례에 '단원별 색' 행을 넣어 어느 색이 어느 단원인지 보이게
  function showUnitLegend() {
    const st = GV().subjectTreeColors && GV().subjectTreeColors();
    const lg = document.getElementById("cyLegend");
    if (!st || !st.ucolor || !lg) return;
    const old = lg.querySelector(".lg-units"); if (old) old.remove();
    const items = Object.keys(st.ucolor).map((uid) => h("span", { class: "lg-item", "data-uid": uid }, [
      h("span", { class: "lg-dot", style: "background:" + st.ucolor[uid] }), (graph.node(uid) || {}).name || uid
    ]));
    const row = h("div", { class: "lg-row lg-units" }, [h("b", {}, ["단원"])].concat(items));
    lg.insertBefore(row, lg.firstChild);
    const mode = document.getElementById("modeText"); if (mode) mode.textContent = "● 노드 색 = 단원별";
  }

  // 도달도 진행바 — 수행능력 통과 가중치(MASTERY.weight) 기반. 미평가는 빈 트랙.
  function reachBar(m) {
    const mi = SAGE.MASTERY[m]; const w = m === "none" ? 0 : mi.weight;
    return h("div", { class: "reachbar" }, [
      h("div", { class: "reachbar-fill", style: "width:" + w + "%;background:" + mi.color })
    ]);
  }

  function searchFocus(q) {
    const hits = GV().searchMatches(q);
    if (!hits.length) { setHint("검색 결과 없음: " + q); return; }
    if (state._sq !== q) { state._sq = q; state._si = 0; } else { state._si = (state._si + 1) % hits.length; }
    const id = hits[state._si];
    state.selNode = id; GV().focus(id); renderPanel();
    setHint("검색 " + (state._si + 1) + "/" + hits.length + " · [" + (graph.node(id).code || id) + "] (Enter로 다음)");
  }

  function filterEl() {
    const M = SAGE.MASTERY;
    const chip = (m) => {
      const on = state.masteryFilter.indexOf(m) >= 0;
      const el = h("div", { class: "fchip" + (on ? " on" : "") }, [
        h("span", { class: "lg-dot", style: "background:" + M[m].color }), M[m].label]);
      el.onclick = () => { toggleMastery(m, el); };
      return el;
    };
    return h("div", { class: "cy-filter" }, [h("b", {}, ["도달도 필터"]),
      chip("full"), chip("partial"), chip("weak"), chip("none")]);
  }
  function toggleMastery(m, el) {
    const i = state.masteryFilter.indexOf(m);
    if (i >= 0) state.masteryFilter.splice(i, 1); else state.masteryFilter.push(m);
    el.classList.toggle("on");
    GV().filterByMastery(state.masteryFilter);
  }

  function subjectSelect() {
    const sel = h("select", { class: "subj-select", onChange: (e) => { enterDetail(e.target.value); } });
    const subs = graph.nodesByType("subject");
    const order = { "중학교": 0, "공통": 1, "기본": 2, "일반선택": 3, "진로선택": 4, "융합선택": 5 };
    subs.sort((a, b) => (order[a.track] - order[b.track]) || a.name.localeCompare(b.name));
    subs.forEach((s) => {
      const o = h("option", { value: s.id }, [s.name]);
      if (s.id === state.subjectId) o.selected = true;
      sel.appendChild(o);
    });
    return sel;
  }

  const HINT_VIEW = "노드를 클릭하면 그 개념의 선행(선수) 성취수준만 거슬러 표시됩니다 · 휠로 확대축소, 드래그로 이동";
  const HINT_EDIT = "편집 모드: 성취기준을 클릭해 세부 수행능력을 편집하세요. 성취기준 간 화살표는 수행능력의 '선수 수행능력'(🔗선수)을 연결하면 자동으로 생깁니다.";
  function setHint(t) { const el = document.getElementById("cyHint"); if (el) el.textContent = t; }

  function toggleEdit() {
    state.editMode = !state.editMode;
    state.selEdge = null; state.editPending = null; state.editMsg = null; state.editTab = "skill";
    GV().setEditMode(state.editMode); GV().setEditTab("skill");
    const t = document.getElementById("editToggle");
    if (t) { t.classList.toggle("on", state.editMode); t.textContent = state.editMode ? "✓ 편집 끝내기" : "✎ 편집 모드"; }
    setHint(state.editMode ? HINT_EDIT : HINT_VIEW);
    renderPanel();
  }
  function setEditTab(t) { state.editTab = t; state.selEdge = null; state.editPending = null; state.editMsg = null; GV().setEditTab(t); renderPanel(); }
  function addSkill(sid, name) {
    const res = SAGE.Edits.addSkill(graph, sid, name);
    state.editMsg = res.ok ? { bad: false, t: "수행능력 추가됨" } : { bad: true, t: res.msg };
    renderPanel();
  }
  function removeSkill(sid, skillId) { SAGE.Edits.removeSkill(graph, sid, skillId); state.editMsg = { bad: false, t: "수행능력 삭제됨" }; renderPanel(); }
  function downloadSkills() {
    const json = SAGE.Edits.exportSkills(graph);
    const blob = new Blob([json], { type: "application/json" }), url = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = url; a.download = "skills-edited.json"; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  }
  function onEditStatus(kind, id) { state.editPending = kind === "src" ? id : null; state.editMsg = null; renderPanel(); }
  function onEditClear() { state.selEdge = null; state.editPending = null; renderPanel(); }
  function onCreateEdge(from, to) {
    if (GV().wouldCycle(from, to)) { state.editMsg = { bad: true, t: "순환(서로 선수)이 생겨 추가할 수 없습니다." }; renderPanel(); return; }
    const res = SAGE.Edits.addEdge(graph, from, to);
    if (!res.ok) { state.editMsg = { bad: true, t: res.msg }; renderPanel(); return; }
    GV().addEdgeEl(from, to);
    state.editMsg = { bad: false, t: "선수관계 추가됨: " + (graph.node(from).code || from) + " → " + (graph.node(to).code || to) };
    renderPanel();
  }
  function onSelectEdge(id, from, to) { state.selEdge = { id, from, to }; state.editPending = null; renderPanel(); }
  function deleteSelEdge() {
    const e = state.selEdge; if (!e) return;
    SAGE.Edits.removeEdge(graph, e.from, e.to);
    if (e.id) GV().removeEdgeEl(e.id); else GV().removeEdgeByPair(e.from, e.to);
    state.editMsg = { bad: false, t: "선수관계 삭제됨" }; state.selEdge = null; renderPanel();
  }
  function starToggle(id) { const on = SAGE.Edits.toggleStar(graph, id); GV().restyleNode(id); state.editMsg = { bad: false, t: on ? "★ 중요 표시함" : "중요 표시 해제" }; renderPanel(); }
  function downloadExport() {
    const json = SAGE.Edits.exportPrereq(graph);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = url; a.download = "prereq-edited.json"; document.body.appendChild(a); a.click();
    a.remove(); URL.revokeObjectURL(url);
  }
  function resetEdits() {
    if (!confirm("교사 편집(추가/삭제한 선수관계·중요표시)을 모두 초기화할까요?")) return;
    SAGE.Edits.reset(); location.reload();
  }

  // 편집 불러오기: 내보낸 prereq-edited.json / skills-edited.json 을 다시 적용·병합 (다중 선택 가능)
  function importEdits() {
    const inp = h("input", { type: "file", accept: ".json,application/json", multiple: "true", style: "display:none" });
    inp.addEventListener("change", () => {
      const files = [].slice.call(inp.files || []);
      if (!files.length) return;
      let pending = files.length; const summary = []; let anyOk = false;
      files.forEach((f) => {
        const reader = new FileReader();
        reader.onload = () => {
          try {
            const parsed = JSON.parse(reader.result);
            const res = SAGE.Edits.importEdits(graph, parsed);
            if (res.ok) {
              anyOk = true;
              const bits = [res.kinds.join("·")];
              if (res.added) bits.push("선수관계 +" + res.added);
              if (res.deleted) bits.push("선수관계 −" + res.deleted);
              if (res.skilled) bits.push("수행능력 " + res.skilled + "개 기준");
              if (res.linked) bits.push("활동연결 " + res.linked + "개");
              if (res.prereqed) bits.push("수행능력 선수관계 " + res.prereqed + "개");
              if (res.skipped) bits.push("건너뜀 " + res.skipped);
              summary.push("✓ " + f.name + " — " + bits.join(", "));
            } else summary.push("✕ " + f.name + " — " + res.msg);
          } catch (err) { summary.push("✕ " + f.name + " — JSON을 읽지 못했습니다."); }
          if (--pending === 0) finishImport(summary, anyOk);
        };
        reader.onerror = () => { summary.push("✕ " + f.name + " — 파일 읽기 실패"); if (--pending === 0) finishImport(summary, anyOk); };
        reader.readAsText(f);
      });
    });
    document.body.appendChild(inp); inp.click();
    setTimeout(() => inp.remove(), 0);
  }
  function finishImport(summary, anyOk) {
    if (!anyOk) { state.editMsg = { bad: true, t: summary.join(" / ") }; renderPanel(); return; }
    alert("불러오기 완료\n\n" + summary.join("\n") + "\n\n변경을 적용하기 위해 새로고침합니다.");
    location.reload();
  }

  function toggleAutoLayout() {
    state.autoLayout = !state.autoLayout;
    const btn = document.getElementById("autoLayoutToggle");
    if (state.autoLayout) {
      const ok = GV().runElk();
      if (!ok) { state.autoLayout = false; setHint("자동 정렬을 사용할 수 없습니다."); return; }
      if (btn) { btn.classList.add("on"); btn.textContent = "▦ 학년 배열"; }
      setHint("자동 정렬: 층 배치·교차 최소화 (학년 띠는 잠시 숨김) · 다시 누르면 학년 배열로");
    } else { GV().unmount(); buildWorkspaceShell(); refreshWorkspace(); setHint(HINT_VIEW); }
  }
  function toggleCollapse() {
    state.collapsed = !state.collapsed;
    const btn = document.getElementById("collapseToggle");
    if (state.collapsed) { GV().collapseAllSubjects(); if (btn) { btn.classList.add("on"); btn.textContent = "과목 펼치기"; } }
    else { GV().expandAllSubjects(); if (btn) { btn.classList.remove("on"); btn.textContent = "과목 접기"; } }
  }

  function toggleShowAll() {
    const next = !GV().showAll;
    GV().setShowAll(next);
    const t = document.getElementById("showAllToggle");
    if (t) { t.classList.toggle("on", next); t.textContent = next ? "선택 선만 보기" : "전체 선 보기"; }
  }
  function toggleVerified() {
    const next = !GV().verifiedOnly;
    GV().setVerifiedOnly(next);
    const t = document.getElementById("verifiedToggle");
    if (t) { t.classList.toggle("on", next); t.textContent = next ? "초안 포함" : "검수선만"; }
  }
  function toggleDownstream() {
    const next = !GV().downstream;
    GV().setHighlightDownstream(next);
    const t = document.getElementById("downToggle");
    if (t) { t.classList.toggle("on", next); t.textContent = next ? "선행만" : "후속까지"; }
  }
  function toggleSubjectTree() {
    state.subjectTree = !state.subjectTree;
    const t = document.getElementById("treeToggle");
    if (state.subjectTree) {
      const ok = GV().runSubjectTree(state.subjectId);
      if (!ok) { state.subjectTree = false; setHint("이 과목을 트리로 정렬할 수 없습니다."); return; }
      if (t) { t.classList.add("on"); t.textContent = "단원 배열"; }
      showUnitLegend();
      setHint(graph.node(state.subjectId).name + " 을(를) 선수관계 트리로 정렬했습니다 · 다시 누르면 학년 배열로");
    } else { GV().unmount(); buildWorkspaceShell(); refreshWorkspace(); setHint(HINT_VIEW); }
  }
  function toggleKeyOnly() {
    const next = !GV().keyOnly;
    GV().setKeyOnly(next);
    const t = document.getElementById("keyToggle");
    if (t) { t.classList.toggle("on", next); t.textContent = next ? "전체 보기" : "핵심만"; }
  }
  function setupKeyboard() {
    document.addEventListener("keydown", (e) => {
      // 계통도가 마운트된 뷰에서만(tree=전체 개념트리, det:*=과목 상세) — 종전 "workspace" 비교는 항상 거짓이라 단축키가 죽어 있었음
      if (!(mountedKind === "tree" || (typeof mountedKind === "string" && mountedKind.indexOf("det:") === 0))) return;
      if (!window.SAGE.GraphView) return;
      const tag = (e.target.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      const s = 90;
      if (e.key === "ArrowLeft") { GV().panBy(s, 0); e.preventDefault(); }
      else if (e.key === "ArrowRight") { GV().panBy(-s, 0); e.preventDefault(); }
      else if (e.key === "ArrowUp") { GV().panBy(0, s); e.preventDefault(); }
      else if (e.key === "ArrowDown") { GV().panBy(0, -s); e.preventDefault(); }
      else if (e.key === "+" || e.key === "=") GV().zoomBy(1.2);
      else if (e.key === "-" || e.key === "_") GV().zoomBy(0.83);
      else if (e.key === "0" || e.key.toLowerCase() === "f") GV().fitAll();
      else if (e.key === "Escape") GV().clearHighlight();
      else if (e.key === "/") { const el = document.getElementById("cySearch"); if (el) { el.focus(); e.preventDefault(); } }
    });
  }

  function refreshWorkspace() {
    GV().applyColors();
    if (state.screen === "result") { state.masteryFilter = ["full", "partial", "weak", "none"]; GV().clearFilter(); }
    const mt = document.getElementById("modeText"); if (mt) mt.textContent = colorModeText();
    // 도달도 필터: 진단 결과가 있는 계통도 화면에서만 툴바에 표시
    const slot = document.getElementById("filterSlot");
    if (slot) { slot.innerHTML = ""; if (state.screen === "map" && state.dx) slot.appendChild(filterEl()); }
    renderPanel();
    // 강조(dim)는 사용자가 노드를 클릭할 때만 — 진입 시엔 전체 색을 그대로 보여줌
  }

  function onNodeSelect(id) { state.legendSubj = null; state.selNode = id; pushSel(id); if (!state.editMode) GV().highlight(id); renderPanel(); highlightLegend(id); }
  // 화살표 한 번 클릭 → 그 화살표가 온 '선수 성취기준' 정보를 패널에 미리보기 (이동·선택 변경 없음)
  function onEdgeTap(srcId) {
    const p = document.getElementById("wpanel"), n = graph.node(srcId); if (!p || !n) return;
    p.innerHTML = "";
    p.appendChild(h("div", { class: "edge-peek" }, ["↗ 이 화살표가 온 선수 성취기준"]));
    mapPanelEls(srcId).forEach((e) => e && p.appendChild(e));
  }
  // 선택한 성취기준의 과목(전체 트리)/단원(과목 트리)을 좌하단 범례에서 강조
  function highlightLegend(id) {
    const n = graph.node(id); if (!n) return;
    if (state.view === "tree") {
      const u = graph.node(n.parent), subj = u && u.parent;
      document.querySelectorAll(".ct-leg-item").forEach((el) => el.classList.toggle("on", el.getAttribute("data-subj") === subj));
    } else if (state.view === "detail" && state.subjectTree) {
      document.querySelectorAll(".lg-units .lg-item").forEach((el) => el.classList.toggle("on", el.getAttribute("data-uid") === n.parent));
    }
  }
  function focusPrereq(id) {
    const n = graph.node(id), sub = n && graph.node(n.parent) ? graph.node(n.parent).parent : null;
    state.selNode = id; pushSel(id);
    if (state.view === "detail" && sub && sub !== state.detailSubject) {   // 교과 간 선행 → 그 과목으로 드릴다운
      state._pendingFocus = id; enterDetail(sub); return;
    }
    GV().focus(id); renderPanel();
  }
  // A8: 선택 이동 이력(뒤로/앞으로)
  function pushSel(id) {
    if (!id) return; const h = state.history;
    if (h[state.histIdx] === id) return;
    h.splice(state.histIdx + 1); h.push(id); state.histIdx = h.length - 1; updateNavBtns();
  }
  function navTo(id) { state.selNode = id; GV().focus(id); renderPanel(); updateNavBtns(); }
  function goBack() { if (state.histIdx > 0) { state.histIdx--; navTo(state.history[state.histIdx]); } }
  function goForward() { if (state.histIdx < state.history.length - 1) { state.histIdx++; navTo(state.history[state.histIdx]); } }
  function updateNavBtns() {
    const b = document.getElementById("navBack"), f = document.getElementById("navFwd");
    if (b) b.classList.toggle("disabled", state.histIdx <= 0);
    if (f) f.classList.toggle("disabled", state.histIdx >= state.history.length - 1);
  }

  function renderPanel() {
    const p = document.getElementById("wpanel"); if (!p) return;
    p.innerHTML = "";
    const els = state.editMode ? editorPanelEls()
      : (state.screen === "result" ? resultPanelEls() : mapPanelEls());
    els.forEach((e) => e && p.appendChild(e));
  }

  function editorPanelEls() {
    const msg = state.editMsg;
    // 성취기준 간 화살표는 블록 직접 연결이 아니라 '수행능력 선수관계'로만 만들어진다.
    const head = [h("div", { class: "p-label" }, ["계통도 편집 (교사)"]),
      h("div", { class: "edit-status" }, ["성취기준 간 연결은 직접 잇지 않습니다. 각 수행능력의 ", h("strong", {}, ["🔗선수"]), " (선수 수행능력)를 연결하면 두 성취기준 사이 화살표가 자동으로 그려집니다."]),
      msg ? h("div", { class: "edit-msg" + (msg.bad ? " bad" : "") }, [msg.t]) : null];
    return head.concat(skillEditorEls());
  }

  // 수행능력 id → 이름 (현재 그래프 전체에서 검색)
  function skillNameOf(skillId) {
    for (const n of graph.nodes.values()) { if (n.skills) { const s = n.skills.find((k) => k.id === skillId); if (s) return s.name; } }
    return skillId;
  }
  function actUnitList(act) { return (act.interactions || act.steps || []).map((u, i) => ({ key: u.id || ("#" + i), unit: u, i: i })); }
  function unitSkills(unit) { return Array.isArray(unit.skillIds) ? unit.skillIds : (unit.skillId ? [unit.skillId] : []); }

  function refreshAdmin() { if (state.screen === "admin") render(); else renderPanel(); }
  function addActLink(actId, key, skillId) { const r = SAGE.Edits.addActSkill(graph, actId, key, skillId); state._skillIdx = null; refreshAdmin(); return r; }
  function removeActLink(actId, key, skillId) { SAGE.Edits.removeActSkill(graph, actId, key, skillId); refreshAdmin(); }
  function downloadActivities() {
    const json = SAGE.Edits.exportActivities(graph);
    const blob = new Blob([json], { type: "application/json" }), url = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = url; a.download = "activity-links-edited.json"; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  }

  /* ========== 관리자: 활동 관리 전용 화면 ========== */
  function adminScreen() { return state.adminView === "editor" ? adminEditor() : adminList(); }

  function adminList() {
    const wrap = h("div", { class: "admin" });
    wrap.appendChild(h("div", { class: "admin-head" }, [
      h("div", {}, [h("div", { class: "admin-title" }, ["활동 관리"]),
        h("div", { class: "admin-sub" }, [graph.allActivities().length + "개 활동 · 클릭하면 수행능력 연결을 편집합니다"])]),
      h("div", { class: "btn light sm", onClick: goAdminGraph }, ["계통도 편집(선수관계·수행능력)"])
    ]));
    const search = h("input", { class: "admin-search", type: "text", placeholder: "🔍 활동·성취기준 검색" });
    search.value = state.adminQuery || "";
    const body = h("div", { class: "admin-list" });
    function fill() {
      const q = (state.adminQuery || "").trim().toLowerCase();
      body.innerHTML = "";
      const acts = graph.allActivities().slice().sort((a, b) => (a.standardId || "").localeCompare(b.standardId || ""));
      const rows = acts.filter((a) => {
        if (!q) return true; const std = graph.node(a.standardId);
        return ((a.id + " " + (a.title || "") + " " + (a.standardId || "") + " " + ((std && std.name) || "")).toLowerCase()).indexOf(q) >= 0;
      });
      if (!rows.length) { body.appendChild(h("div", { class: "admin-empty" }, ["검색 결과가 없습니다."])); return; }
      rows.forEach((a) => body.appendChild(adminRow(a)));
    }
    search.oninput = () => { state.adminQuery = search.value; fill(); };
    wrap.appendChild(search); wrap.appendChild(body); fill();
    return wrap;
  }
  function adminRow(a) {
    const std = graph.node(a.standardId), units = actUnitList(a);
    const linked = new Set(); units.forEach(({ unit }) => unitSkills(unit).forEach((s) => linked.add(s)));
    const skills = (std && std.skills) || [];
    const missing = skills.filter((s) => !linked.has(s.id)).length;
    return h("div", { class: "admin-row", onClick: () => openAdminAct(a.id) }, [
      h("div", { class: "admin-row-main" }, [
        h("div", { class: "admin-row-title" }, [a.title || a.id]),
        h("div", { class: "admin-row-meta" }, [(a.standardId || "") + " · " + ((std && std.name) || "")])
      ]),
      h("div", { class: "admin-row-stat" }, [
        h("span", { class: "admin-chip" }, ["조작 " + units.length]),
        h("span", { class: "admin-chip" }, ["수행능력 " + linked.size]),
        missing ? h("span", { class: "admin-chip warn" }, ["미연결 " + missing]) : h("span", { class: "admin-chip ok" }, ["✓ 완전"])
      ]),
      h("div", { class: "admin-row-prev", title: "활동 미리보기", onClick: (e) => { e.stopPropagation(); previewActivity(a); } }, ["▶ 미리보기"])
    ]);
  }
  function openAdminAct(id) { state.adminAct = id; state.adminView = "editor"; state._pickOpen = null; state._pickSubj = null; state._pickQuery = ""; render(); }
  function adminBackToList() { state.adminView = "list"; state.adminAct = null; state._pickOpen = null; state.editMode = false; render(); }

  function adminEditor() {
    const a = graph.activityById(state.adminAct);
    const wrap = h("div", { class: "admin" });
    if (!a) { wrap.appendChild(h("div", { class: "btn light sm", onClick: adminBackToList }, ["← 활동 목록"])); wrap.appendChild(h("div", { class: "admin-empty" }, ["활동을 찾을 수 없습니다."])); return wrap; }
    const std = graph.node(a.standardId), skills = (std && std.skills) || [], units = actUnitList(a);
    const covered = new Set(); units.forEach(({ unit }) => unitSkills(unit).forEach((s) => covered.add(s)));
    const missing = skills.filter((s) => !covered.has(s.id));
    wrap.appendChild(h("div", { class: "admin-bar" }, [
      h("div", { class: "btn light sm", onClick: adminBackToList }, ["← 활동 목록"]),
      h("div", { class: "btn primary sm", onClick: () => previewActivity(a) }, ["▶ 활동 미리보기"])
    ]));
    wrap.appendChild(h("div", { class: "admin-act-title" }, [a.title || a.id]));
    wrap.appendChild(h("div", { class: "admin-act-sub" }, [(a.standardId || "") + " · " + ((std && std.name) || "")]));
    wrap.appendChild(h("div", { class: "act-cover" + (missing.length ? " warn" : "") }, [
      missing.length ? ("⚠ 이 성취기준에서 평가에 연결 안 된 수행능력: " + missing.map((s) => s.name).join(", ")) : "✓ 이 성취기준의 모든 세부 수행능력이 연결됨"
    ]));
    units.forEach(({ key, unit, i }) => wrap.appendChild(adminUnit(a, key, unit, i)));
    wrap.appendChild(h("div", { class: "admin-foot" }, [
      h("div", { class: "note" }, ["한 조작에 여러 수행능력을(다른 성취기준 포함) 연결할 수 있습니다. 변경은 자동 저장. 파일 반영은 내보내 ", h("code", {}, ["data/activities/"]), " 에 적용."]),
      h("div", { class: "foot-btns" }, [
        h("div", { class: "btn primary grow", onClick: downloadActivities }, ["활동연결 내보내기"]),
        h("div", { class: "btn light", onClick: importEdits }, ["불러오기"]),
        h("div", { class: "btn light", onClick: resetEdits }, ["초기화"])
      ])
    ]));
    return wrap;
  }
  function adminUnit(a, key, unit, i) {
    const cur = unitSkills(unit);
    const chips = cur.map((sid) => h("span", { class: "sk-chip" }, [
      h("span", { class: "sk-chip-name" }, [skillNameOf(sid)]),
      h("span", { class: "sk-chip-code" }, [sid]),
      h("span", { class: "sk-chip-x", title: "연결 해제", onClick: () => removeActLink(a.id, key, sid) }, ["✕"])
    ]));
    const open = state._pickOpen === key;
    const addBtn = h("div", { class: "sk-add-btn" + (open ? " on" : ""), onClick: () => { state._pickOpen = open ? null : key; state._pickQuery = ""; render(); } }, [open ? "− 닫기" : "+ 수행능력 연결"]);
    const els = [
      h("div", { class: "act-unit-q" }, [h("span", { class: "act-unit-kind" }, [String(i + 1)]), (unit.kind ? unit.kind : "문제") + " · " + (unit.prompt || "").slice(0, 70)]),
      h("div", { class: "sk-chips" }, chips.length ? chips : [h("span", { class: "sk-none" }, ["연결된 수행능력 없음"])]),
      addBtn
    ];
    if (open) els.push(skillPicker(a.id, key, cur));
    return h("div", { class: "act-unit" }, els);
  }
  function subjOfStd(stdId) { const n = graph.node(stdId); const u = n && graph.node(n.parent); return u && u.parent; }
  function allSkillIndex() {
    if (state._skillIdx) return state._skillIdx;
    const idx = [];
    for (const n of graph.nodes.values()) {
      if (n.type === "standard" && n.skills) {
        const u = graph.node(n.parent), subj = u && u.parent;
        n.skills.forEach((s) => idx.push({ id: s.id, name: s.name, code: n.code || n.id, stdId: n.id, stdName: n.name, subj: subj, unitName: (u && u.name) || "" }));
      }
    }
    state._skillIdx = idx; return idx;
  }
  // 같은 활동(조작)에서 함께 평가되어 '연결된' 다른 수행능력들 → Map(otherSkillId → Set(활동제목))
  function connectedSkills(skillId) {
    const m = new Map();
    graph.allActivities().forEach((a) => {
      (a.interactions || a.steps || []).forEach((u) => {
        const ids = Array.isArray(u.skillIds) ? u.skillIds : (u.skillId ? [u.skillId] : []);
        if (ids.indexOf(skillId) < 0) return;
        ids.forEach((o) => { if (o !== skillId) { if (!m.has(o)) m.set(o, new Set()); m.get(o).add(a.title || a.id); } });
      });
    });
    return m;
  }
  function stdOfSkill(skillId) { const s = allSkillIndex().find((x) => x.id === skillId); return s ? s.stdId : null; }
  // 이미 연결된 수행능력들의 '선수 수행능력' 추천 목록 (활동 피커 상단에 노출)
  function prereqRecommend(curIds, excludeSet) {
    const out = [], seen = new Set();
    curIds.forEach((sid) => SAGE.Edits.skillPrereqsOf(sid).forEach((pid) => { if (!seen.has(pid) && !excludeSet.has(pid)) { seen.add(pid); out.push(pid); } }));
    return out;
  }
  // 범용 수행능력 선택창 (과목 칩 + 그룹 + 연결됨 표시 + 추천 섹션). opts: {ns, defaultStd, isOn, onToggle, refresh, exclude, recommended}
  function genericSkillPicker(opts) {
    const idx = allSkillIndex();
    const SUBJ_ORDER = ["9수", "10공수1", "10공수2", "12대수", "12미적Ⅰ", "12미적Ⅱ", "12기하", "확통"];
    const present = SUBJ_ORDER.filter((sid) => idx.some((s) => s.subj === sid));
    const subjKey = "_" + opts.ns + "Subj", qKey = "_" + opts.ns + "Q";
    if (state[subjKey] == null) state[subjKey] = (opts.defaultStd && subjOfStd(opts.defaultStd)) || present[0] || "*";
    const box = h("div", { class: "sk-picker" });
    if (opts.recommended && opts.recommended.length) {
      const rec = h("div", { class: "sk-rec" }, [h("div", { class: "sk-rec-label" }, ["💡 연결한 수행능력의 선수 수행능력"])]);
      opts.recommended.forEach((pid) => rec.appendChild(h("div", { class: "sk-pick-row rec", onClick: () => opts.onToggle(pid) }, [
        h("span", { class: "sk-pick-mark" }, ["+"]), h("span", { class: "sk-pick-name" }, [skillNameOf(pid)]), h("span", { class: "sk-pick-code" }, [pid])
      ])));
      box.appendChild(rec);
    }
    const chipRow = h("div", { class: "pick-subj-row" });
    chipRow.appendChild(h("div", { class: "pick-subj" + (state[subjKey] === "*" ? " on" : ""), onClick: () => { state[subjKey] = "*"; opts.refresh(); } }, ["전체"]));
    present.forEach((sid) => chipRow.appendChild(h("div", { class: "pick-subj" + (state[subjKey] === sid ? " on" : ""), onClick: () => { state[subjKey] = sid; opts.refresh(); } }, [SUBJ_NAME[sid] || sid])));
    box.appendChild(chipRow);
    const inp = h("input", { class: "sk-pick-input", type: "text", placeholder: "검색 (코드·내용) — 비우면 과목 전체" });
    inp.value = state[qKey] || "";
    const results = h("div", { class: "sk-pick-results" });
    function fill() {
      const q = (state[qKey] || "").trim().toLowerCase(); results.innerHTML = "";
      let list = idx.filter((s) => (state[subjKey] === "*" || s.subj === state[subjKey]) && !(opts.exclude && opts.exclude.has(s.id)));
      if (q) list = list.filter((s) => (s.id + " " + s.name + " " + s.code + " " + s.stdName).toLowerCase().indexOf(q) >= 0);
      const groups = [], gmap = {};
      list.forEach((s) => { if (!gmap[s.code]) { gmap[s.code] = { code: s.code, std: s.stdName, unit: s.unitName, items: [] }; groups.push(gmap[s.code]); } gmap[s.code].items.push(s); });
      if (!groups.length) { results.appendChild(h("div", { class: "sk-none" }, ["결과 없음"])); return; }
      groups.forEach((g) => {
        results.appendChild(h("div", { class: "sk-grp" }, [h("span", { class: "sk-grp-code" }, [g.code]), h("span", { class: "sk-grp-name" }, [g.unit ? g.unit + " · " + g.std : g.std])]));
        g.items.forEach((s) => {
          const on = opts.isOn(s.id);
          results.appendChild(h("div", { class: "sk-pick-row" + (on ? " linked" : ""), title: on ? "해제" : "연결", onClick: () => opts.onToggle(s.id) }, [
            h("span", { class: "sk-pick-mark" }, [on ? "✓" : "+"]),
            h("span", { class: "sk-pick-name" }, [s.name]),
            h("span", { class: "sk-pick-code" }, [s.id]),
            on ? h("span", { class: "sk-pick-tag" }, ["연결됨"]) : null
          ]));
        });
      });
    }
    inp.oninput = () => { state[qKey] = inp.value; fill(); };
    box.appendChild(inp); box.appendChild(results); fill();
    return box;
  }
  // 활동 ↔ 수행능력 연결 선택창 (선수 수행능력 추천 포함)
  function skillPicker(actId, key, cur) {
    const curSet = new Set(cur), a = graph.activityById(actId);
    return genericSkillPicker({
      ns: "pick", defaultStd: a.standardId, recommended: prereqRecommend(cur, curSet),
      isOn: (id) => curSet.has(id),
      onToggle: (id) => curSet.has(id) ? removeActLink(actId, key, id) : addActLink(actId, key, id),
      refresh: () => render()
    });
  }
  // 수행능력 선수관계 편집 (한 수행능력이 다른 수행능력을 선수로 가짐). 성취기준 화살표는 자동 파생.
  function editSkillPrereq(skillId, prereqId, add) {
    const fromStd = stdOfSkill(prereqId), toStd = stdOfSkill(skillId);
    const had = fromStd && toStd && graph.edges.some((e) => e.rel === "prerequisite" && e.from === fromStd && e.to === toStd);
    if (add) { const r = SAGE.Edits.addSkillPrereq(graph, skillId, prereqId); if (!r.ok) { state.editMsg = { bad: true, t: r.msg }; renderPanel(); return; } }
    else SAGE.Edits.removeSkillPrereq(graph, skillId, prereqId);
    const now = fromStd && toStd && graph.edges.some((e) => e.rel === "prerequisite" && e.from === fromStd && e.to === toStd);
    try { if (!had && now) GV().addEdgeEl(fromStd, toStd); else if (had && !now) GV().removeEdgeByPair(fromStd, toStd); } catch (e) {}
    state.editMsg = { bad: false, t: add ? "선수 수행능력 연결됨" : "선수 연결 해제됨" };
    renderPanel();
  }
  function skillPrereqPicker(skillId) {
    const cur = SAGE.Edits.skillPrereqsOf(skillId), curSet = new Set(cur);
    return genericSkillPicker({
      ns: "prq", defaultStd: stdOfSkill(skillId), exclude: new Set([skillId]),
      isOn: (id) => curSet.has(id),
      onToggle: (id) => editSkillPrereq(skillId, id, !curSet.has(id)),
      refresh: () => renderPanel()
    });
  }
  function previewActivity(a) {
    const clone = JSON.parse(JSON.stringify(a));
    const std = graph.node(clone.standardId);
    (clone.steps || []).forEach((s) => { const sk = std && std.skills && std.skills.find((k) => k.id === s.skillId); s.skillName = sk ? sk.name : ""; });
    (clone.interactions || []).forEach((ix) => { const ids = Array.isArray(ix.skillIds) ? ix.skillIds : (ix.skillId ? [ix.skillId] : []); ix.skillNames = ids.map(skillNameOf); });
    const host = h("div", { class: "preview-host" });
    const tpl = SAGE.Templates[clone.templateType];
    const pstep = { i: 0, submitted: false, lastPass: null };
    const draw = () => {
      host.innerHTML = "";
      if (clone.flow === "stepper" && tpl && tpl.renderOne) {
        const units = clone.interactions || [], ix = units[pstep.i];
        const dots = h("div", { class: "stp-dots" }, units.map((u, k) => h("span", { class: "stp-dot" + (k < pstep.i ? " done" : (k === pstep.i ? " cur" : "")) })));
        const body = h("div", {});
        if (!pstep.submitted) tpl.renderOne(clone, body, pstep.i);
        else {
          if (ix.prompt) body.appendChild(hMath("stp-recap", ix.prompt));
          body.appendChild(h("div", { class: "stp-fb " + (pstep.lastPass ? "ok" : "no") }, [
            h("div", { class: "stp-fb-h" }, [pstep.lastPass ? "✓ 정확해요" : "✗ 다시 살펴봐요"]),
            ix.explain ? hMath("stp-fb-x", ix.explain) : null]));
        }
        const btns = !pstep.submitted
          ? [h("div", { class: "btn primary grow", onClick: () => { pstep.lastPass = tpl.gradeOne(clone, pstep.i); pstep.submitted = true; draw(); } }, ["제출"]),
             h("div", { class: "btn light", onClick: draw }, ["↺ 초기화"])]
          : (pstep.i >= units.length - 1
              ? [h("div", { class: "btn primary grow", onClick: () => { pstep.i = 0; pstep.submitted = false; draw(); } }, ["↺ 처음부터"])]
              : [h("div", { class: "btn primary grow", onClick: () => { pstep.i++; pstep.submitted = false; draw(); } }, ["다음 미션 →"])]);
        host.appendChild(h("div", { class: "act-inner" }, [
          h("div", { class: "act-cat", style: "text-align:center;margin-bottom:6px" }, ["미션 " + (pstep.i + 1) + " / " + units.length]),
          (ix.skillNames && ix.skillNames.length) ? h("div", { class: "stp-skills" }, ix.skillNames.map((nm) => h("span", { class: "ix-skill" }, [nm]))) : null,
          dots, body, h("div", { class: "act-btns" }, btns)]));
      } else if (tpl && tpl.render) tpl.render(clone, host);
      else host.textContent = "미리보기를 지원하지 않는 활동 형식입니다.";
    };
    const overlay = h("div", { class: "preview-overlay" }, [
      h("div", { class: "preview-modal" }, [
        h("div", { class: "preview-top" }, [h("div", { class: "preview-title" }, [clone.title || clone.id]),
          h("div", { class: "preview-tools" }, [
            h("div", { class: "btn light sm", title: "입력 초기화", onClick: draw }, ["↺ 초기화"]),
            h("div", { class: "preview-close", title: "닫기" }, ["✕"])])]),
        h("div", { class: "preview-scroll" }, [host])
      ])
    ]);
    overlay.onclick = (e) => { if (e.target === overlay || e.target.classList.contains("preview-close")) overlay.remove(); };
    document.body.appendChild(overlay);
    draw();
  }

  function edgeEditorEls() {
    const pend = state.editPending && graph.node(state.editPending);
    const se = state.selEdge;
    const selN = state.selNode && graph.node(state.selNode);
    return [
      h("div", { class: "edit-status" }, [
        pend ? h("div", {}, ["출발(선수) 개념: ", h("strong", {}, [pend.code || pend.id]), " — 이제 상위 개념을 클릭하세요"])
             : h("div", {}, ["선수(아래) → 상위 개념 순으로 두 노드를 클릭해 선수관계를 추가합니다. 선을 클릭하면 삭제."])
      ]),
      se ? h("div", { class: "edge-card" }, [
        h("div", { class: "p-label" }, ["선택한 선수관계"]),
        h("div", { class: "edge-pair" }, [
          h("span", { class: "prereq-code" }, [graph.node(se.from).code || se.from]), " → ",
          h("span", { class: "prereq-code" }, [graph.node(se.to).code || se.to])
        ]),
        h("div", { class: "btn danger", onClick: deleteSelEdge }, ["이 선수관계 삭제"])
      ]) : null,
      selN ? h("div", { class: "star-row" }, [
        h("div", { class: "star-btn", onClick: () => starToggle(selN.id) }, [(selN.starred ? "★ 중요 표시됨 " : "☆ 중요 표시 ") + (selN.code || selN.id)])
      ]) : null,
      h("div", { class: "panel-foot" }, [
        h("div", { class: "note" }, ["변경은 자동 저장(localStorage). 파일 반영은 내보내 ", h("code", {}, ["data/edges/"]), " 에 저장."]),
        h("div", { class: "foot-btns" }, [
          h("div", { class: "btn primary grow", onClick: downloadExport }, ["선수관계 내보내기"]),
          h("div", { class: "btn light", onClick: importEdits }, ["불러오기"]),
          h("div", { class: "btn light", onClick: resetEdits }, ["초기화"])
        ])
      ])
    ];
  }

  function skillEditorEls() {
    const selN = state.selNode && graph.node(state.selNode);
    if (!selN || selN.type !== "standard")
      return [h("div", { class: "edit-status" }, ["성취기준 노드를 클릭하면 그 성취기준의 세부 수행능력을 추가·삭제할 수 있습니다."])];
    const skills = selN.skills || [];
    const input = h("input", { class: "skill-input", type: "text", placeholder: "예: 표본공간과 사건을 구분한다." });
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { addSkill(selN.id, input.value); } });
    return [
      h("div", { class: "p-code" }, ["[" + (selN.code || selN.id) + "]"]),
      hMath("p-title", selN.name),
      h("div", { class: "p-label mt" }, ["세부 수행능력 (" + skills.length + ") ", h("span", { class: "p-hint-mini" }, ["· 🔗선수 = 선수 수행능력 연결"])]),
      h("div", { class: "skill-list" }, skills.length
        ? skills.map((s) => {
            const pre = SAGE.Edits.skillPrereqsOf(s.id);
            const open = state._prqPickerFor === s.id;
            const rowEls = [
              h("div", { class: "skill-edit-row" }, [
                h("span", { class: "skbullet" }), h("span", { class: "se-name" }, [s.name]), h("span", { class: "se-code" }, [s.id]),
                h("span", { class: "se-prq" + (open ? " on" : ""), title: "선수 수행능력 연결", onClick: () => { state._prqPickerFor = open ? null : s.id; state._prqQ = ""; renderPanel(); } }, ["🔗선수 " + (pre.length || "")]),
                h("span", { class: "se-del", title: "수행능력 삭제", onClick: () => removeSkill(selN.id, s.id) }, ["✕"])
              ])
            ];
            if (open || pre.length) {
              const items = pre.map((pid) => h("div", { class: "sk-conn-row" }, [
                spanMath("sk-conn-name", skillNameOf(pid)), h("span", { class: "sk-conn-code" }, [pid]),
                h("span", { class: "sk-chip-x", title: "선수 해제", onClick: () => editSkillPrereq(s.id, pid, false) }, ["✕"])
              ]));
              const box = [h("div", { class: "sk-conn-h" }, ["선수 수행능력"])].concat(items.length ? items : [h("div", { class: "sk-none" }, ["없음"])]);
              if (open) box.push(skillPrereqPicker(s.id));
              rowEls.push(h("div", { class: "sk-conn-box" }, box));
            }
            return h("div", { class: "skill-wrap" }, rowEls);
          })
        : [h("div", { class: "skill muted" }, ["아직 없습니다. 아래에서 추가하세요."])]),
      h("div", { class: "skill-add" }, [input, h("div", { class: "btn primary sm", onClick: () => addSkill(selN.id, input.value) }, ["추가"])]),
      h("div", { class: "panel-foot" }, [
        h("div", { class: "note" }, ["수행능력 선수관계를 연결하면 성취기준 화살표가 자동으로 그려집니다. 파일 반영은 내보내 ", h("code", {}, ["data/"]), " 에 반영."]),
        h("div", { class: "foot-btns" }, [
          h("div", { class: "btn primary grow", onClick: downloadSkills }, ["수행능력 내보내기"]),
          h("div", { class: "btn primary grow", onClick: downloadSkillPrereq }, ["선수관계 내보내기"]),
          h("div", { class: "btn light", onClick: importEdits }, ["불러오기"]),
          h("div", { class: "btn light", onClick: resetEdits }, ["초기화"])
        ])
      ])
    ];
  }
  function downloadSkillPrereq() {
    const json = SAGE.Edits.exportSkillPrereq();
    const blob = new Blob([json], { type: "application/json" }), url = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = url; a.download = "skill-prereq-edited.json"; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  }

  function prereqDepth(id) {   // 선수개념을 따라 거슬러 올라가는 최대 단계 수
    const memo = {};
    function d(x, seen) {
      if (memo[x] != null) return memo[x];
      if (seen.has(x)) return 0;
      seen.add(x);
      const ps = graph.prerequisitesOf(x);
      const r = ps.length ? 1 + Math.max.apply(null, ps.map((p) => d(p, seen))) : 0;
      seen.delete(x); memo[x] = r; return r;
    }
    return d(id, new Set());
  }
  function prereqNav(id) {
    const pres = graph.prerequisitesOf(id);
    if (!pres.length) return h("div", { class: "skill muted" }, ["선행 성취수준이 없습니다 (출발 개념)"]);
    return h("div", { class: "prereq-list" }, pres.map((pid) => {
      const n = graph.node(pid);
      return h("div", { class: "prereq", onClick: () => focusPrereq(pid) }, [
        h("span", { class: "prereq-code" }, [n.code || n.id]),
        spanMath("prereq-name", n.name),
        h("span", { class: "prereq-go" }, ["↑"])
      ]);
    }));
  }

  function mapPanelEls(forId) {
    const id = forId || state.selNode, n = id && graph.node(id);
    if (!n) return [h("div", { class: "p-label" }, ["성취기준을 클릭해 선행 개념을 살펴보세요"])];
    const m = state.dx ? state.dx.masteryOf(id) : "none", mi = SAGE.MASTERY[m];
    const skills = n.skills || [];
    const unit = graph.node(n.parent), subj = graph.node(unit.parent);
    const terms = unit && unit.terms || [];
    return [
      h("div", { class: "p-label" }, [subj.name + " · " + unit.name]),
      h("div", { class: "p-codeline" }, [
        h("span", { class: "p-code" }, ["[" + (n.code || n.id) + "]"]),
        n.category ? h("span", { class: "p-cat " + (n.category === "과정·기능" ? "proc" : "know") }, [n.category]) : null
      ]),
      hMath("p-title", n.name),
      n.note ? h("div", { class: "p-haesol" }, ["💬 " + n.note]) : null,  // 교육과정 성취기준 해설
      n.link ? h("div", { class: "p-link" }, ["📎 교육과정 연계 — " + n.link]) : null,  // 선수 연계 공식 근거
      h("div", { class: "p-state" }, [h("span", { class: "dot", style: "background:" + mi.color }), mi.label]),
      state.dx ? reachBar(m) : null,
      terms.length ? h("div", { class: "p-label mt" }, ["핵심 용어·기호 (교육과정)"]) : null,
      terms.length ? h("div", { class: "term-list" }, terms.map((t) => h("span", { class: "term-chip" }, [t]))) : null,
      h("div", { class: "p-label mt" }, ["세부 수행능력 ", h("span", { class: "p-hint-mini" }, ["· 클릭 = 선수 수행능력 보기"])]),
      h("div", { class: "skill-list" }, skills.length
        ? skills.map((s) => {
            const open = state._openSkill === s.id;
            const row = h("div", { class: "skill clickable" + (open ? " open" : ""), onClick: () => { state._openSkill = open ? null : s.id; renderPanel(); } },
              [h("span", { class: "skbullet" }), spanMath("se-m", s.name), h("span", { class: "se-code" }, [s.id]), h("span", { class: "sk-link-ic" }, [open ? "▾" : "🔗"])]);
            if (!open) return row;
            const pre = SAGE.Edits.skillPrereqsOf(s.id);
            const items = pre.map((pid) => h("div", { class: "sk-conn-row" }, [spanMath("sk-conn-name", skillNameOf(pid)), h("span", { class: "sk-conn-code" }, [pid])]));
            return h("div", { class: "skill-wrap" }, [row, h("div", { class: "sk-conn-box" }, [
              h("div", { class: "sk-conn-h" }, ["선수 수행능력 (이 능력에 필요한 선행 능력)"])
            ].concat(items.length ? items : [h("div", { class: "sk-none" }, ["등록된 선수 수행능력이 없습니다. (관리자 → 세부 수행능력 탭에서 연결)"])]))]);
          })
        : [h("div", { class: "skill muted" }, ["(추후 교사·AI가 추가 예정)"])]),
      h("div", { class: "p-label mt" }, ["선행 성취수준 · 거슬러 올라가기 " + prereqDepth(id) + "단계"]),
      prereqNav(id),
      h("div", { class: "star-row" }, [
        h("div", { class: "star-btn", onClick: () => starToggle(id) }, [n.starred ? "★ 중요 표시됨" : "☆ 중요 표시"])
      ]),
      h("div", { class: "panel-foot" }, [
        state.dx
          ? h("div", { class: "btn primary", onClick: () => { state.screen = "activity"; render(); } }, ["진단 시작하기"])
          : h("div", { class: "btn primary", onClick: startDiagnosis }, ["이 과목 진단하기"])
      ])
    ];
  }

  function resultPanelEls() {
    const rep = state.dx.report(), circ = 188.5, offset = circ * (1 - rep.overall / 100);
    return [
      h("div", { class: "p-label" }, ["진단 리포트"]),
      h("div", { class: "ring-row" }, [ringSVG(offset, circ),
        h("div", {}, [h("div", { class: "ring-num" }, [String(rep.overall), h("span", { class: "pct" }, ["%"])]),
          h("div", { class: "ring-sub" }, ["전체 성취 도달"])])]),
      h("div", { class: "p-label mt" }, ["성취기준별 결과 ", h("span", { class: "p-hint-mini" }, ["· 세부 수행능력 단위 판정"])]),
      h("div", { class: "result-list" }, rep.perStandard.map((r) => {
        // 수행능력별 판정 — 이 진단의 핵심 산출물 (✓보유 · ✗미보유 · ⊘건너뜀 · 미측정은 생략)
        const node = graph.node(r.id), sr = state.dx.skillResults || {};
        const skillEls = ((node && node.skills) || []).map((s) => {
          const st = sr[s.id]; if (!st) return null;
          const icon = st === "pass" ? "✓" : (st === "fail" ? "✗" : "⊘");
          return h("span", { class: "rskill " + st, title: s.id }, [icon + " " + s.name]);
        }).filter(Boolean);
        return h("div", { class: "rrow", onClick: () => focusPrereq(r.id) }, [
          h("div", { class: "rrow-top" }, [
            h("span", { class: "dot", style: "background:" + SAGE.MASTERY[r.mastery].color }),
            spanMath("rstd", r.name),
            r.skipped ? h("span", { class: "rskip" }, ["모르겠어요"]) : null,
            h("span", { class: "rlabel" }, [SAGE.MASTERY[r.mastery].label])]),
          reachBar(r.mastery),
          skillEls.length ? h("div", { class: "rskill-row" }, skillEls) : null]);
      })),
      h("div", { class: "panel-foot" }, [
        rep.recommendation
          ? h("div", { class: "note rec" }, ["💡 ", h("strong", {}, [rep.recommendation.name]), " 부터 다시 짚어보면 전반이 함께 올라가요."])
          : h("div", { class: "note" }, ["🎉 점검한 성취기준을 모두 이해하고 있어요. 잘하고 있습니다!"]),
        rep.recommendation
          ? h("div", { class: "btn light wide", onClick: () => focusPrereq(rep.recommendation.id) }, ["🔦 약점 경로 계통도에서 보기"])
          : null,
        h("div", { class: "foot-btns" }, [
          h("div", { class: "btn primary grow", onClick: restart }, ["다시 진단"]),
          h("div", { class: "btn light", onClick: () => { state.screen = "map"; render(); } }, ["계통도"])
        ])
      ])
    ];
  }
  function ringSVG(offset, circ) {
    const ns = "http://www.w3.org/2000/svg", svg = document.createElementNS(ns, "svg");
    svg.setAttribute("width", "74"); svg.setAttribute("height", "74"); svg.setAttribute("viewBox", "0 0 74 74");
    svg.innerHTML = '<circle cx="37" cy="37" r="30" fill="none" stroke="#E4E9DE" stroke-width="7"></circle>' +
      '<circle cx="37" cy="37" r="30" fill="none" stroke="#5B7A5B" stroke-width="7" stroke-linecap="round" stroke-dasharray="' +
      circ + '" stroke-dashoffset="' + offset + '" transform="rotate(-90 37 37)"></circle>';
    return svg;
  }
  function restart() { clearSave(); state.dx = null; state._stp = null; state.selNode = "12확통02-03"; state.screen = "start"; render(); }

  /* ---------- activity screen ---------- */
  function activityScreen() {
    const dx = state.dx;
    if (!dx || dx.isDone()) { finishToResult(); return h("div"); }
    const cur = dx.current(), act = cur && cur.activity;
    if (!cur || !act || !cur.node) { dx.ptr++; setTimeout(render, 0); return h("div"); }   // 깨진 항목은 건너뜀(복원 데이터 방어)
    const units = act.steps || act.interactions || [];
    const localSkills = cur.node.skills || [];
    const nameOf = (id) => {
      let sk = localSkills.find((k) => k.id === id);
      if (!sk) { const nd = graph.node(id.replace(/-[a-z]$/i, "")); if (nd && nd.skills) sk = nd.skills.find((k) => k.id === id); }
      return sk ? sk.name : id;
    };
    units.forEach((s) => {
      const ids = Array.isArray(s.skillIds) ? s.skillIds : (s.skillId ? [s.skillId] : []);
      s.skillNames = ids.map(nameOf);
      s.skillName = s.skillNames[0] || "수행능력";   // stepwise 호환
    });

    // 스텝형 활동: 한 화면에 미션 하나, 제출하면 다음으로
    if (act.flow === "stepper" && act.templateType === "interactive") return stepperScreen(dx, cur, act, units);

    const host = h("div", { class: "widget" });
    SAGE.Templates[act.templateType].render(act, host);
    const isBacktrack = dx.ptr > 0 && !isOriginTop(cur.standardId);

    return h("div", { class: "activity" }, [h("div", { class: "act-inner" }, [
      isBacktrack ? h("div", { class: "back-note" }, ["↩︎ 이 개념의 바탕이 되는 ", h("strong", {}, [cur.node.name]), " 을(를) 거슬러 올라가 점검할게요."]) : null,
      h("div", { class: "act-tag-row" }, [h("span", { class: "act-tag" }, [cur.node.code]), h("span", { class: "act-cat" }, [cur.node.category || ""])]),
      h("h2", { class: "act-title" }, [act.title || cur.node.name]),
      host,
      h("div", { class: "act-btns" }, [
        h("div", { class: "btn primary grow", onClick: () => onCheck(act) }, ["확인"]),
        h("div", { class: "btn light", title: "이 활동의 입력을 모두 비웁니다", onClick: () => render() }, ["↺ 초기화"]),
        h("div", { class: "btn ghost", onClick: onSkip }, ["모르겠어요"])
      ]),
      h("div", { class: "diag-hint" }, ["진단형 — 정답은 마지막 리포트에서 확인할 수 있어요."])
    ])]);
  }
  function isOriginTop(id) {
    const scope = state.mode === "precise"
      ? graph.standardsInSubject(state.subjectId).map((n) => n.id)
      : graph.standardsInUnit(state.unitId).map((n) => n.id);
    return graph.topStandards(scope).includes(id);
  }
  function onCheck(act) { const r = SAGE.Templates[act.templateType].grade(act); state.dx.submit(r.stepResults); afterAnswer(); }
  function onSkip() { state.dx.skip(); afterAnswer(); }
  function afterAnswer() { if (state.dx.isDone()) finishToResult(); else render(); }
  function finishToResult() { state.screen = "result"; state.selNode = state.dx.path[0] || state.selNode; render(); }

  /* ---------- 스텝형: 미션 하나씩, 제출→피드백→다음 ---------- */
  function stepperScreen(dx, cur, act, units) {
    if (!state._stp || state._stp.actId !== act.id) state._stp = { actId: act.id, i: 0, results: [], submitted: false, lastPass: null, attempts: {}, retried: {} };
    const st = state._stp; st.attempts = st.attempts || {}; st.retried = st.retried || {};
    if (st.i >= units.length) { const results = units.map((u, k) => st.results[k] || "fail"); state._stp = null; dx.submit(results); afterAnswer(); return h("div"); }
    const ix = units[st.i];
    const host = h("div", { class: "widget" });
    if (!st.submitted) SAGE.Templates.interactive.renderOne(act, host, st.i);
    else {
      if (ix.prompt) host.appendChild(hMath("stp-recap", ix.prompt));
      // 해설(explain)은 정답 시에만 — 오답 시 정답 수치·결론 노출은 이후 미션 답을 누설한다. 오답은 힌트만.
      const canRetry = !st.lastPass && (st.attempts[st.i] || 0) < 2;
      host.appendChild(h("div", { class: "stp-fb " + (st.lastPass ? "ok" : "no") }, [
        h("div", { class: "stp-fb-h" }, [st.lastPass ? "✓ 정확해요" : "✗ 다시 살펴봐요"]),
        st.lastPass
          ? (ix.explain ? hMath("stp-fb-x", ix.explain) : null)
          : hMath("stp-fb-x", (ix.hint || "핵심 개념을 다시 떠올려 보세요.") + (canRetry ? " 한 번 더 시도할 수 있어요." : " 정답과 풀이는 탐사 완료 후 리포트에서 확인할 수 있어요."))
      ]));
    }
    const dots = h("div", { class: "stp-dots" }, units.map((u, k) => h("span", { class: "stp-dot" + (k < st.i ? " done" : (k === st.i ? " cur" : "")) })));
    const retryOk = !st.lastPass && (st.attempts[st.i] || 0) < 2;
    const btns = !st.submitted
      ? [h("div", { class: "btn primary grow", onClick: () => stepSubmit(act) }, ["제출"]),
         h("div", { class: "btn light", title: "이 미션 입력 비우기", onClick: () => render() }, ["↺ 초기화"]),
         h("div", { class: "btn ghost", onClick: () => stepSkip(act) }, ["모르겠어요"])]
      : (retryOk
          ? [h("div", { class: "btn primary grow", onClick: () => stepRetry() }, ["↻ 다시 해보기"]),
             h("div", { class: "btn ghost", onClick: () => stepNext(act, units) }, [st.i >= units.length - 1 ? "그냥 완료" : "그냥 다음으로"])]
          : [h("div", { class: "btn primary grow", onClick: () => stepNext(act, units) }, [st.i >= units.length - 1 ? "탐사 완료 →" : "다음 미션 →"])]);
    return h("div", { class: "activity" }, [h("div", { class: "act-inner" }, [
      h("div", { class: "act-tag-row" }, [h("span", { class: "act-tag" }, [cur.node.code]), h("span", { class: "act-cat" }, ["미션 " + (st.i + 1) + " / " + units.length])]),
      h("h2", { class: "act-title" }, [act.title || cur.node.name]),
      (ix.skillNames && ix.skillNames.length) ? h("div", { class: "stp-skills" }, ix.skillNames.map((nm) => h("span", { class: "ix-skill" }, [nm]))) : null,
      dots, host,
      h("div", { class: "act-btns" }, btns),
      h("div", { class: "diag-hint" }, ["하나의 탐사입니다 — 각 미션의 산출물이 다음 미션으로 이어집니다."])
    ])]);
  }
  function stepSubmit(act) {
    const st = state._stp;
    const pass = SAGE.Templates.interactive.gradeOne(act, st.i);
    st.results[st.i] = pass ? "pass" : "fail";
    st.lastPass = pass;
    if (!pass) st.attempts[st.i] = (st.attempts[st.i] || 0) + 1;
    st.submitted = true; render();
  }
  function stepRetry() { const st = state._stp; st.retried[st.i] = true; st.submitted = false; st.lastPass = null; render(); }
  function stepSkip(act) { const st = state._stp; st.results[st.i] = "fail"; st.attempts[st.i] = 9; st.lastPass = false; st.submitted = true; render(); }
  function stepNext(act, units) {
    const st = state._stp; st.i++; st.submitted = false; st.lastPass = null;
    if (st.i >= units.length) { const results = units.map((u, k) => st.results[k] || "fail"); state._stp = null; state.dx.submit(results); afterAnswer(); }
    else render();
  }

  /* ---------- boot ---------- */
  async function boot() {
    try {
      if (typeof cytoscape !== "undefined") {
        if (typeof cytoscapeDagre !== "undefined") cytoscape.use(cytoscapeDagre);
        try { if (window.cytoscapeElk) cytoscape.use(window.cytoscapeElk); } catch (e) {}
        try { if (window.cytoscapeExpandCollapse) cytoscape.use(window.cytoscapeExpandCollapse); } catch (e) {}
      }
      graph = await SAGE.Graph.load("data/manifest.json");
      SAGE.Edits.applyTo(graph);   // 교사 편집(선수관계 추가/삭제·중요표시) 반영
      state.selNode = "12확통02-03";
      setupKeyboard();
      render();
    } catch (err) {
      $app().innerHTML = '<div class="error"><h3>데이터를 불러오지 못했습니다.</h3><p>' + err.message +
        '</p><p class="hint">로컬에서 파일을 더블클릭하면 브라우저 보안정책으로 JSON을 못 읽습니다.<br>' +
        '<code>python3 -m http.server</code> 실행 후 <code>localhost:8000</code> 으로 여세요.</p></div>';
      console.error(err);
    }
  }
  document.addEventListener("DOMContentLoaded", boot);
})();
