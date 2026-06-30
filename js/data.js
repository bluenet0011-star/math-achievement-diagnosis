/* data.js — 콘텐츠(JSON) 로더 + 그래프 헬퍼. 단일 출처(§4) */
(function () {
  "use strict";

  const MASTERY = {
    full:    { color: "#5B8A5B", label: "완전 이해", weight: 100 },
    partial: { color: "#C99A4A", label: "부분 이해", weight: 55 },
    weak:    { color: "#C16A4E", label: "미흡",      weight: 20 },
    none:    { color: "#C6CEBE", label: "미평가",    weight: 0 }
  };

  // 도달도 임계값 (계획서 §11-5, 설정값으로 분리)
  const THRESHOLDS = { full: 0.9, partial: 0.5 };

  function masteryFromRatio(ratio, attempted) {
    if (!attempted) return "none";
    if (ratio >= THRESHOLDS.full) return "full";
    if (ratio >= THRESHOLDS.partial) return "partial";
    return "weak";
  }

  // 활동의 채점 단위(steps=문제형 · interactions=조작형)에 안정 키를 부여해 나열
  function actUnits(activity) {
    const arr = (activity && (activity.interactions || activity.steps)) || [];
    return arr.map((u, i) => ({ key: u.id || ("#" + i), unit: u, index: i }));
  }
  function unitSkillIds(unit) {
    if (Array.isArray(unit.skillIds)) return unit.skillIds.slice();
    return unit.skillId ? [unit.skillId] : [];
  }
  // 수행능력 id → 소속 성취기준 id
  function skillStdMap(graph) {
    const m = {};
    for (const n of graph.nodes.values()) { if (n.type === "standard" && n.skills) n.skills.forEach((s) => { m[s.id] = n.id; }); }
    return m;
  }
  // 수행능력 선수관계(skillPrereq)로부터 성취기준 간선을 '파생'해 graph.edges 에 반영
  // (수행능력 A가 다른 성취기준의 수행능력 B를 선수로 가지면 → stdB → stdA prerequisite 간선)
  // prerequisite 간선을 따라 src에서 dst에 도달 가능한가 (순환 방지용)
  function reachableEdges(edges, src, dst) {
    if (src === dst) return true;
    const seen = new Set([src]), stack = [src];
    while (stack.length) {
      const c = stack.pop();
      for (const e of edges) { if (e.rel === "prerequisite" && e.from === c && !seen.has(e.to)) { if (e.to === dst) return true; seen.add(e.to); stack.push(e.to); } }
    }
    return false;
  }
  function deriveStdEdges(graph, store) {
    graph.edges = graph.edges.filter((e) => !e.derivedSkill);              // 이전 파생분 제거
    const m = skillStdMap(graph);
    // 파일 기반(baseSkillPrereq) + 교사 편집(store.skillPrereq) 병합
    const sp = {};
    [graph.baseSkillPrereq || {}, store.skillPrereq || {}].forEach((src) => {
      Object.keys(src).forEach((sid) => { sp[sid] = (sp[sid] || []).concat(src[sid] || []); });
    });
    const seen = new Set(graph.edges.filter((e) => e.rel === "prerequisite").map((e) => e.from + ">>" + e.to));
    Object.keys(sp).forEach((sid) => {
      const toStd = m[sid]; if (!toStd) return;
      sp[sid].forEach((pid) => {
        const fromStd = m[pid]; if (!fromStd || fromStd === toStd) return;
        const k = fromStd + ">>" + toStd; if (seen.has(k)) return;
        if (reachableEdges(graph.edges, toStd, fromStd)) return;          // 순환 생기면 파생 생략(그래프 비순환 유지)
        seen.add(k); graph.edges.push({ from: fromStd, to: toStd, rel: "prerequisite", derivedSkill: true });
      });
    });
  }

  async function fetchJSON(path) {
    const res = await fetch(path, { cache: "no-store" });
    if (!res.ok) throw new Error("불러오기 실패: " + path + " (" + res.status + ")");
    return res.json();
  }

  class Graph {
    constructor() {
      this.nodes = new Map();      // id -> node
      this.edges = [];             // {from,to,rel}
      this.activities = new Map(); // standardId -> [activity]
      this.baseSkillPrereq = {};   // 수행능력 선수관계(파일 기반): skillId -> [선수 skillId]
    }

    static async load(manifestPath) {
      const g = new Graph();
      const manifest = await fetchJSON(manifestPath || "data/manifest.json");
      for (const p of manifest.nodes || []) {
        const d = await fetchJSON(p);
        (d.nodes || []).forEach((n) => g.nodes.set(n.id, n));
      }
      for (const p of manifest.edges || []) {
        const d = await fetchJSON(p);
        (d.edges || []).forEach((e) => g.edges.push(e));
      }
      // 수행능력 선수관계 파일(skillId→skillId) → baseSkillPrereq (성취기준 간선은 deriveStdEdges로 파생)
      for (const p of manifest.skillPrereq || []) {
        const d = await fetchJSON(p);
        (d.edges || []).forEach((e) => {
          if (!e.from || !e.to) return;
          (g.baseSkillPrereq[e.to] = g.baseSkillPrereq[e.to] || []);
          if (g.baseSkillPrereq[e.to].indexOf(e.from) < 0) g.baseSkillPrereq[e.to].push(e.from);
        });
      }
      for (const p of manifest.activities || []) {
        const d = await fetchJSON(p);
        (d.activities || []).forEach((a) => {
          if (!g.activities.has(a.standardId)) g.activities.set(a.standardId, []);
          g.activities.get(a.standardId).push(a);
        });
      }
      return g;
    }

    node(id) { return this.nodes.get(id); }
    nodesByType(t) { return [...this.nodes.values()].filter((n) => n.type === t); }
    childrenOf(parentId) { return [...this.nodes.values()].filter((n) => n.parent === parentId); }

    standardsInUnit(unitId) {
      return [...this.nodes.values()].filter((n) => n.type === "standard" && n.parent === unitId);
    }
    standardsInSubject(subjectId) {
      const units = this.childrenOf(subjectId).filter((n) => n.type === "unit").map((u) => u.id);
      return [...this.nodes.values()].filter((n) => n.type === "standard" && units.includes(n.parent));
    }

    // 선수개념: to=현재 노드인 prerequisite 간선들의 from
    prerequisitesOf(standardId) {
      return this.edges
        .filter((e) => e.rel === "prerequisite" && e.to === standardId)
        .map((e) => e.from)
        .filter((id) => this.nodes.has(id));
    }

    activityFor(standardId) {
      const list = this.activities.get(standardId);
      return list && list.length ? list[0] : null;
    }
    activitiesForStandard(standardId) { return this.activities.get(standardId) || []; }
    allActivities() { const out = []; this.activities.forEach((l) => out.push.apply(out, l)); return out; }
    activityById(id) { for (const l of this.activities.values()) { const a = l.find((x) => x.id === id); if (a) return a; } return null; }

    // 최상위 성취기준 = 같은 평가 범위 안에서 다른 성취기준의 선수개념이 아닌 것.
    // isTop 플래그가 있어도 '범위 내 의존성 없음'을 함께 만족해야 최상위로 인정(잘못된 시작점 방지).
    topStandards(standardIds) {
      const set = new Set(standardIds);
      const noDepInScope = (id) => !this.edges.some((e) => e.rel === "prerequisite" && e.from === id && set.has(e.to));
      const flagged = standardIds.filter((id) => this.node(id) && this.node(id).isTop && noDepInScope(id));
      if (flagged.length) return flagged;
      return standardIds.filter(noDepInScope);
    }
  }

  /* ---------- 교사 편집 patch (선수관계 추가/삭제·중요표시) — localStorage 영속 ---------- */
  const EKEY = "sage.edits.v1";
  const Edits = {
    load() { try { return Object.assign({ add: [], del: [], stars: {}, skills: {}, actLinks: {}, skillPrereq: {} }, JSON.parse(localStorage.getItem(EKEY))); } catch (e) { return { add: [], del: [], stars: {}, skills: {}, actLinks: {}, skillPrereq: {} }; } },
    save(e) { localStorage.setItem(EKEY, JSON.stringify(e)); },
    key(f, t) { return f + ">>" + t; },

    applyTo(graph) {
      const e = this.load();
      this._base = graph.baseSkillPrereq || {};   // 파일 기반 수행능력 선수관계(뷰·파생에서 참조)
      const dead = new Set(e.del.map((d) => this.key(d.from, d.to)));
      graph.edges = graph.edges.filter((x) => !(x.rel === "prerequisite" && dead.has(this.key(x.from, x.to))));
      e.add.forEach((a) => {
        if (graph.nodes.has(a.from) && graph.nodes.has(a.to) &&
            !graph.edges.some((x) => x.rel === "prerequisite" && x.from === a.from && x.to === a.to))
          graph.edges.push({ from: a.from, to: a.to, rel: "prerequisite", user: true });
      });
      Object.keys(e.stars).forEach((id) => { if (graph.nodes.has(id)) graph.node(id).starred = e.stars[id]; });
      Object.keys(e.skills || {}).forEach((id) => { if (graph.nodes.has(id)) graph.node(id).skills = e.skills[id]; });
      // 활동↔수행능력 연결 override 반영
      const al = e.actLinks || {};
      Object.keys(al).forEach((actId) => {
        const act = graph.activityById(actId); if (!act) return;
        actUnits(act).forEach(({ key, unit }) => { if (al[actId][key]) unit.skillIds = al[actId][key].slice(); });
      });
      deriveStdEdges(graph, e);   // 수행능력 선수관계 → 성취기준 간선 파생
      return e;
    },

    addEdge(graph, from, to) {
      if (from === to) return { ok: false, msg: "같은 개념끼리는 연결할 수 없습니다." };
      if (graph.edges.some((x) => x.rel === "prerequisite" && x.from === from && x.to === to))
        return { ok: false, msg: "이미 있는 선수관계입니다." };
      graph.edges.push({ from: from, to: to, rel: "prerequisite", user: true });
      const e = this.load();
      e.del = e.del.filter((d) => !(d.from === from && d.to === to));
      if (!e.add.some((a) => a.from === from && a.to === to)) e.add.push({ from: from, to: to });
      this.save(e);
      return { ok: true };
    },

    removeEdge(graph, from, to) {
      graph.edges = graph.edges.filter((x) => !(x.rel === "prerequisite" && x.from === from && x.to === to));
      const e = this.load();
      const wasAdded = e.add.some((a) => a.from === from && a.to === to);
      e.add = e.add.filter((a) => !(a.from === from && a.to === to));
      if (!wasAdded && !e.del.some((d) => d.from === from && d.to === to)) e.del.push({ from: from, to: to });
      this.save(e);
    },

    toggleStar(graph, id) {
      const n = graph.node(id); n.starred = !n.starred;
      const e = this.load(); e.stars[id] = n.starred; this.save(e);
      return n.starred;
    },

    addSkill(graph, sid, name) {
      const n = graph.node(sid); if (!n) return { ok: false, msg: "성취기준을 찾을 수 없습니다." };
      name = (name || "").trim(); if (!name) return { ok: false, msg: "수행능력 내용을 입력하세요." };
      n.skills = n.skills || [];
      let i = n.skills.length + 1, id;
      do { id = sid + "-s" + i; i++; } while (n.skills.some((s) => s.id === id));
      n.skills.push({ id: id, name: name });
      const e = this.load(); e.skills[sid] = n.skills.map((s) => ({ id: s.id, name: s.name })); this.save(e);
      return { ok: true };
    },
    removeSkill(graph, sid, skillId) {
      const n = graph.node(sid); if (!n || !n.skills) return;
      n.skills = n.skills.filter((s) => s.id !== skillId);
      const e = this.load(); e.skills[sid] = n.skills.map((s) => ({ id: s.id, name: s.name })); this.save(e);
    },
    exportSkills(graph) {
      const e = this.load();
      return JSON.stringify({ _comment: "교사 편집 세부 수행능력 (성취기준 id → skills). nodes 파일의 해당 성취기준 skills에 반영.", skills: e.skills }, null, 1);
    },

    /* ---------- 활동 ↔ 수행능력 연결 편집 (조작 단위별 skillIds override) ---------- */
    setActLink(graph, actId, key, skillIds) {
      const act = graph.activityById(actId); if (!act) return { ok: false, msg: "활동을 찾을 수 없습니다." };
      const u = actUnits(act).find((x) => x.key === key); if (!u) return { ok: false, msg: "조작 단위를 찾을 수 없습니다." };
      u.unit.skillIds = skillIds.slice();
      const e = this.load(); e.actLinks = e.actLinks || {}; e.actLinks[actId] = e.actLinks[actId] || {};
      e.actLinks[actId][key] = skillIds.slice(); this.save(e);
      return { ok: true };
    },
    addActSkill(graph, actId, key, skillId) {
      const act = graph.activityById(actId); if (!act) return { ok: false, msg: "활동을 찾을 수 없습니다." };
      const u = actUnits(act).find((x) => x.key === key); if (!u) return { ok: false, msg: "조작 단위를 찾을 수 없습니다." };
      const cur = unitSkillIds(u.unit);
      if (cur.indexOf(skillId) >= 0) return { ok: false, msg: "이미 연결된 수행능력입니다." };
      cur.push(skillId);
      return this.setActLink(graph, actId, key, cur);
    },
    removeActSkill(graph, actId, key, skillId) {
      const act = graph.activityById(actId); if (!act) return;
      const u = actUnits(act).find((x) => x.key === key); if (!u) return;
      this.setActLink(graph, actId, key, unitSkillIds(u.unit).filter((s) => s !== skillId));
    },
    exportActivities(graph) {
      const e = this.load();
      return JSON.stringify({ _comment: "교사 편집 활동↔수행능력 연결 (activityId → 조작키 → skillIds). data/activities 의 해당 조작 skillIds 에 반영.", actLinks: e.actLinks || {} }, null, 1);
    },

    /* ---------- 수행능력 선수관계 (skillId → 선수 skillIds). 성취기준 간선은 이로부터 파생 ---------- */
    // 파일 기반(base) + 교사 편집 병합
    skillPrereqsOf(sid) {
      const e = this.load(), base = (this._base && this._base[sid]) || [], usr = (e.skillPrereq || {})[sid] || [];
      const out = base.slice(); usr.forEach((x) => { if (out.indexOf(x) < 0) out.push(x); }); return out;
    },
    addSkillPrereq(graph, sid, pid) {
      if (sid === pid) return { ok: false, msg: "자기 자신은 선수로 둘 수 없습니다." };
      if (this.skillPrereqsOf(sid).indexOf(pid) >= 0) return { ok: false, msg: "이미 선수 수행능력입니다." };
      // 성취기준 수준의 순환 방지 (다단계 포함): stdTo가 이미 stdFrom의 선행이면 추가 시 순환
      const m = skillStdMap(graph), sF = m[pid], sT = m[sid];
      if (sF && sT && sF !== sT && reachableEdges(graph.edges, sT, sF)) return { ok: false, msg: "성취기준 간 순환이 생겨 추가할 수 없습니다." };
      const e = this.load(); e.skillPrereq = e.skillPrereq || {}; e.skillPrereq[sid] = e.skillPrereq[sid] || [];
      e.skillPrereq[sid].push(pid); this.save(e); deriveStdEdges(graph, e); return { ok: true };
    },
    removeSkillPrereq(graph, sid, pid) {
      const e = this.load(); if (e.skillPrereq && e.skillPrereq[sid]) { e.skillPrereq[sid] = e.skillPrereq[sid].filter((x) => x !== pid); this.save(e); deriveStdEdges(graph, e); }
    },
    exportSkillPrereq() {
      const e = this.load();
      return JSON.stringify({ _comment: "수행능력 선수관계 (skillId → 선수 skillIds). 성취기준 간선은 이로부터 파생됨.", skillPrereq: e.skillPrereq || {} }, null, 1);
    },

    reset() { localStorage.removeItem(EKEY); },

    /* ---------- 편집 불러오기(import) — 내보낸 파일을 다시 적용·병합 ----------
       prereq 파일은 "전체 선수관계 스냅샷"이므로 베이스(파일 원본) 대비 diff로 환산해
       기존 편집과 병합한다(파일 우선: 파일에 있으면 add, 베이스에 있는데 파일에 없으면 del).
       skills 파일은 성취기준별 override 맵이므로 노드 단위로 덮어써 병합한다.
       한 파일에 edges/skills가 섞여 있어도 모두 처리. 저장만 하며, 적용은 호출측에서 reload. */
    importEdits(graph, parsed) {
      const e = this.load();
      const kinds = []; let added = 0, deleted = 0, skilled = 0, skipped = 0;
      if (parsed && Array.isArray(parsed.edges)) {
        kinds.push("선수관계");
        const r = this._mergePrereq(graph, e, parsed.edges);
        added = r.added; deleted = r.deleted; skipped += r.skipped;
      }
      if (parsed && parsed.skills && typeof parsed.skills === "object" && !Array.isArray(parsed.skills)) {
        kinds.push("수행능력");
        Object.keys(parsed.skills).forEach((id) => {
          if (!graph.nodes.has(id)) { skipped++; return; }
          const list = (parsed.skills[id] || [])
            .filter((s) => s && s.id && s.name)
            .map((s) => ({ id: s.id, name: s.name }));
          e.skills[id] = list; skilled++;
        });
      }
      let prereqed = 0;
      if (parsed && parsed.skillPrereq && typeof parsed.skillPrereq === "object" && !Array.isArray(parsed.skillPrereq)) {
        kinds.push("수행능력 선수관계");
        e.skillPrereq = e.skillPrereq || {};
        Object.keys(parsed.skillPrereq).forEach((sid) => { e.skillPrereq[sid] = (parsed.skillPrereq[sid] || []).slice(); prereqed++; });
        deriveStdEdges(graph, e);   // 임포트 즉시 성취기준 간선 재파생(reload 전 일관성)
      }
      let linked = 0;
      if (parsed && parsed.actLinks && typeof parsed.actLinks === "object" && !Array.isArray(parsed.actLinks)) {
        kinds.push("활동연결");
        e.actLinks = e.actLinks || {};
        Object.keys(parsed.actLinks).forEach((actId) => {
          if (!graph.activityById(actId)) { skipped++; return; }
          e.actLinks[actId] = Object.assign({}, e.actLinks[actId], parsed.actLinks[actId]); linked++;
        });
      }
      if (!kinds.length) return { ok: false, msg: "선수관계·수행능력·활동연결·수행능력 선수관계가 없는 파일입니다." };
      this.save(e);
      return { ok: true, kinds: kinds, added: added, deleted: deleted, skilled: skilled, linked: linked, prereqed: prereqed, skipped: skipped };
    },

    // 베이스(파일 원본) 선수관계 키 = 현재 그래프 키 − 내가 추가한 것 + 내가 지운 것
    _mergePrereq(graph, e, importedEdges) {
      const addK = new Set(e.add.map((a) => this.key(a.from, a.to)));
      const delK = new Set(e.del.map((d) => this.key(d.from, d.to)));
      const baseK = new Set(graph.edges.filter((x) => x.rel === "prerequisite").map((x) => this.key(x.from, x.to)));
      addK.forEach((k) => baseK.delete(k));
      delK.forEach((k) => baseK.add(k));

      const target = importedEdges.filter((x) => x && x.from && x.to && (x.rel || "prerequisite") === "prerequisite");
      const targetK = new Set(target.map((x) => this.key(x.from, x.to)));
      let added = 0, deleted = 0, skipped = 0;

      // 파일이 추가한 간선 (베이스에 없던 것) → add 로 병합
      target.forEach((x) => {
        const k = this.key(x.from, x.to);
        if (baseK.has(k)) return;
        if (!graph.nodes.has(x.from) || !graph.nodes.has(x.to)) { skipped++; return; }
        if (!e.add.some((a) => a.from === x.from && a.to === x.to)) { e.add.push({ from: x.from, to: x.to }); added++; }
        e.del = e.del.filter((d) => !(d.from === x.from && d.to === x.to));
      });
      // 파일이 지운 간선 (베이스에 있는데 파일엔 없는 것) → del 로 병합
      baseK.forEach((k) => {
        if (targetK.has(k)) return;
        const i = k.indexOf(">>"); const from = k.slice(0, i), to = k.slice(i + 2);
        if (!e.del.some((d) => d.from === from && d.to === to)) { e.del.push({ from: from, to: to }); deleted++; }
        e.add = e.add.filter((a) => !(a.from === from && a.to === to));
      });
      return { added: added, deleted: deleted, skipped: skipped };
    },

    exportPrereq(graph) {
      const edges = graph.edges.filter((x) => x.rel === "prerequisite").map((x) => {
        const o = { from: x.from, to: x.to, rel: "prerequisite" };
        if (x.draft) o.draft = true; if (x.curated) o.curated = true; if (x.user) o.user = true;
        return o;
      });
      return JSON.stringify({ _comment: "교사 편집 반영 선수관계 (내보내기)", edges: edges }, null, 1);
    }
  };

  window.SAGE = window.SAGE || {};
  window.SAGE.Graph = Graph;
  window.SAGE.MASTERY = MASTERY;
  window.SAGE.masteryFromRatio = masteryFromRatio;
  window.SAGE.Edits = Edits;
})();
