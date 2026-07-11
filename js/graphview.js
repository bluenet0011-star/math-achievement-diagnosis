/* graphview.js — Cytoscape 계통도 (과목▸단원▸성취기준 묶음 + 선수관계 오버레이)
   요구사항: 겹침 없는 배치 / 확대·축소·이동 / 클릭 시 선행만 강조 / 전체 선 토글 / 빠른 선행 탐색 */
(function () {
  "use strict";
  const SAGE = window.SAGE;

  const TRACK_COLOR = {
    "중학교": "#7E8BA3", "공통": "#5B7A5B", "기본": "#A38B6E",
    "일반선택": "#C08A4A", "진로선택": "#8E7BA3", "융합선택": "#6FA38E"
  };
  const TRACK_ORDER = { "중학교": 0, "공통": 1, "기본": 2, "일반선택": 3, "진로선택": 4, "융합선택": 5 };
  const TIER_LIST = ["중학교", "공통", "기본", "일반선택", "진로선택", "융합선택"];
  const TIER_LABEL = { "중학교": "중학교", "공통": "고1 · 공통", "기본": "고1 · 기본", "일반선택": "고2 · 일반선택", "진로선택": "진로 선택", "융합선택": "융합 선택" };
  const NODE_W = 190, V_GAP = 24, UNIT_GAP = 46, SUBJ_GAP = 116, TIER_GAP = 156, LABEL_X = -240;
  const STUB_LANE = 26;   // 디테일에서 교과 간 선수개념 칩을 올려둘 노드 상단 여백
  function nodeH(name) { const cpl = 13; const lines = Math.max(1, Math.ceil((name || "").length / cpl)); return Math.max(50, lines * 17 + 22); }
  // 색을 흰색 쪽으로 t(0~1)만큼 섞어 옅게 — 그라데이션 출발색(테이퍼) 생성용
  function lighten(hex, t) {
    const h = (hex || "#888888").replace("#", "");
    const r = parseInt(h.substr(0, 2), 16), g0 = parseInt(h.substr(2, 2), 16), b = parseInt(h.substr(4, 2), 16);
    const mix = (c) => Math.round(c + (255 - c) * t);
    const hx = (c) => ("0" + mix(c).toString(16)).slice(-2);
    return "#" + hx(r) + hx(g0) + hx(b);
  }

  let cy = null, g = null, ctx = null, showAll = false, ec = null, mini = null, miniCleanup = null;
  let editMode = false, pendingSrc = null, edgeSeq = 0, editTab = "edge", verifiedOnly = false, hlDownstream = false;
  let nodePos = {};   // id -> {x,y,colLeft,subj,lastCol} (간선 통로 라우팅용)
  let subjTree = null;   // 과목 트리 모드일 때 {ucolor, unitOf} — applyColors가 단원색으로 칠함

  // 절대좌표 경유점 배열 → segments의 weight/distance(상대값)로 변환 (직교 통로 라우팅)
  function segPts(sx, sy, tx, ty, pts) {
    const dx = tx - sx, dy = ty - sy, L2 = dx * dx + dy * dy || 1, L = Math.sqrt(L2);
    const sw = [], sd = [];
    pts.forEach((p) => { const ax = p[0] - sx, ay = p[1] - sy; sw.push((ax * dx + ay * dy) / L2); sd.push((ax * dy - ay * dx) / L); });
    return { sw: sw, sd: sd };
  }

  function trackOf(id) { const s = g.node(id), u = s && g.node(s.parent), sj = u && g.node(u.parent); return (sj && sj.track) || "공통"; }
  function subjectOf(id) { const s = g.node(id), u = s && g.node(s.parent); return u && u.parent; }
  function subjectSize(s) {   // {w,h} 과목 박스 크기 (단원 열 × 가변높이 성취기준 스택)
    const units = g.childrenOf(s.id).filter((n) => n.type === "unit");
    const w = units.length * NODE_W + Math.max(0, units.length - 1) * UNIT_GAP;
    let h = 0;
    units.forEach((u) => {
      let uh = 0;
      g.standardsInUnit(u.id).forEach((st) => { uh += nodeH(g.node(st.id).name) + V_GAP; });
      h = Math.max(h, Math.max(0, uh - V_GAP));
    });
    return { w: w, h: h, units: units };
  }

  function buildElements() {
    const els = [];
    nodePos = {};
    const PAD = 26;
    const detailId = (ctx && ctx.detailSubject && g.node(ctx.detailSubject)) ? ctx.detailSubject : null;

    // 디테일: 이 과목 성취기준이 의존하는 '다른 과목' 선수개념을 모아 칩(stub)으로 표시
    const stubMap = {};
    if (detailId) {
      g.edges.forEach((e) => {
        if (e.rel !== "prerequisite") return;
        if (subjectOf(e.to) !== detailId) return;          // 의존(하위) 개념이 이 과목이어야
        const psj = subjectOf(e.from);
        if (!psj || psj === detailId) return;              // 선수개념이 다른 과목일 때만
        const arr = (stubMap[e.to] = stubMap[e.to] || []);
        if (!arr.some((x) => x.subj === psj)) arr.push({ subj: psj, name: (g.node(psj) || {}).name || psj, prereq: e.from });
      });
    }

    function emitSubject(s, x0, y0, tierIdxVal, tierBottomVal) {
      const sz = subjectSize(s);
      const detail = (s.id === detailId);
      els.push({ data: { id: s.id, label: s.name, kind: "subject", track: s.track } });
      // 1차: 단원별 열 높이(디테일이면 칩 레인 포함) → 짧은 열을 세로 중앙 정렬하기 위함
      const cols = sz.units.map((u) => {
        const stds = g.standardsInUnit(u.id).sort((a, b) => (a.code || a.id).localeCompare(b.code || b.id));
        let h = 0;
        stds.forEach((st) => { h += (detail && stubMap[st.id] ? STUB_LANE : 0) + nodeH(st.name) + V_GAP; });
        return { u: u, stds: stds, h: Math.max(0, h - V_GAP) };
      });
      const maxH = Math.max(sz.h, ...cols.map((c) => c.h), 0);
      cols.forEach((col, ui) => {
        els.push({ data: { id: col.u.id, parent: s.id, label: col.u.name, kind: "unit" } });
        const ux = x0 + ui * (NODE_W + UNIT_GAP);
        const lastCol = (ui === cols.length - 1);
        let cyy = (maxH - col.h) / 2;   // 열 세로 중앙 정렬
        col.stds.forEach((st) => {
          const chips = detail ? stubMap[st.id] : null;
          if (chips) cyy += STUB_LANE;
          const hh = nodeH(st.name);
          const cx = ux + NODE_W / 2, cyAbs = y0 + cyy + hh / 2;
          els.push({
            data: { id: st.id, parent: col.u.id, label: st.name, code: st.code || st.id,
              track: s.track, subj: s.id, kind: "std", starred: !!st.starred, top: !!g.node(st.id).isTop, h: hh },
            position: { x: cx, y: cyAbs }
          });
          nodePos[st.id] = { x: cx, y: cyAbs, colLeft: ux, subj: s.id, lastCol: lastCol, tierBottom: tierBottomVal != null ? tierBottomVal : cyAbs, tier: tierIdxVal };
          // 교과 간 선수개념 칩: 노드 상단에 부착(에지 없이 시각적으로만), 클릭 시 해당 과목으로 드릴다운
          if (chips) {
            const show = chips.slice(0, 2);
            const cyChip = cyAbs - hh / 2 - STUB_LANE / 2 + 3;
            show.forEach((sb, ci) => {
              const n = show.length;
              const sx = cx + (n === 1 ? 0 : (ci - (n - 1) / 2) * (NODE_W / n));
              const extra = (chips.length > 2 && ci === n - 1) ? " +" + (chips.length - 1) : "";
              els.push({ data: { id: "stub::" + st.id + "::" + sb.subj, kind: "stub",
                label: "↑ " + sb.name + extra, toSubj: sb.subj, toPrereq: sb.prereq, track: (g.node(sb.subj) || {}).track || "공통" },
                position: { x: sx, y: cyChip }, grabbable: false });
            });
          }
          cyy += hh + V_GAP;
        });
      });
      return sz;
    }

    if (detailId) {
      // 해결 2: 디테일 — 한 과목만 원점에 촘촘히(학년 띠 없음)
      emitSubject(g.node(detailId), 0, 0, 0, null);
    } else {
      // 전체: 학년 세로 배열 (오버뷰는 app이 별도 카드 그리드로 처리)
      const subjects = g.nodesByType("subject");
      const byTier = {};
      subjects.forEach((s) => { (byTier[s.track] = byTier[s.track] || []).push(s); });
      let y0 = 0, tierIdx = 0;
      TIER_LIST.forEach((tier) => {
        const list = (byTier[tier] || []).sort((a, b) => a.id.localeCompare(b.id));
        if (!list.length) return;
        const myTier = tierIdx++;
        let tierH = 0; list.forEach((s) => { tierH = Math.max(tierH, subjectSize(s).h); });
        let x = 0;
        list.forEach((s) => { const sz = emitSubject(s, x, y0, myTier, y0 + tierH); x += sz.w + SUBJ_GAP; });
        const tierW = x - SUBJ_GAP;
        els.push({ data: { id: "band-" + tier, kind: "band", track: tier, w: tierW + PAD * 2 - LABEL_X + 40, h: tierH + PAD * 2 },
          position: { x: (LABEL_X - 40 + tierW + PAD) / 2, y: y0 + tierH / 2 }, selectable: false, grabbable: false });
        els.push({ data: { id: "tier-" + tier, label: TIER_LABEL[tier] || tier, kind: "tier" },
          position: { x: LABEL_X, y: y0 + tierH / 2 }, selectable: false, grabbable: false });
        y0 += tierH + TIER_GAP;
      });
    }

    g.edges.forEach((e, i) => {
      if (e.rel !== "prerequisite" || !nodePos[e.from] || !nodePos[e.to]) return;
      let cls = e.user ? "user" : e.curated ? "curated" : e.draft ? "draft" : "base";
      const data = { id: "e" + i, source: e.from, target: e.to };
      // 부드러운 곡선이 박스 사이 통로 쪽으로 살짝 휘게 — 짧은 간선도 곡선이라 화살표가 또렷
      const ps = nodePos[e.from], pt = nodePos[e.to];
      const jitter = ((i % 5) - 2) * 2;
      const gut = (np) => np.lastCol ? np.colLeft - UNIT_GAP / 2 : np.colLeft + NODE_W + UNIT_GAP / 2;
      if (ps && pt) {
        const dx = pt.x - ps.x, dy = pt.y - ps.y, L = Math.hypot(dx, dy) || 1;
        let bowX;
        if (ps.subj === pt.subj) {
          if (Math.abs(ps.colLeft - pt.colLeft) < 1) bowX = gut(ps);
          else bowX = (pt.x > ps.x ? ps.colLeft + NODE_W + UNIT_GAP / 2 : ps.colLeft - UNIT_GAP / 2);
        } else bowX = gut(ps);
        bowX += jitter;
        const my = (ps.y + pt.y) / 2;
        const perp = ((bowX - ps.x) * dy - (my - ps.y) * dx) / L;   // 중점 수직 오프셋(부호)
        if (L < 110) {                 // B: 짧은 간선은 직선(갈고리 방지) + 마커 축소
          data.cpd = 0; cls += " shortedge";
        } else {
          const mag = Math.min(Math.abs(perp), 0.18 * L + 6);       // D: 곡률 더 절제(완만한 곡선)
          data.cpd = Math.round((perp < 0 ? -1 : 1) * mag);
        }
        data.routed = 1;
        if (Math.abs((ps.tier || 0) - (pt.tier || 0)) >= 2) cls += " faredge";   // 여러 학년 건너뛰는 선은 약하게
      }
      els.push({ data: data, classes: cls });
    });
    return els;
  }

  function style() {
    return [
      { selector: "node[kind='band']", style: {
        "shape": "round-rectangle", "background-color": (n) => TRACK_COLOR[n.data("track")] || "#000000",
        "background-opacity": 0.07, "border-width": 0, "width": "data(w)", "height": "data(h)",
        "events": "no", "z-index": 0 } },
      { selector: "node[kind='std']", style: {
        "shape": "round-rectangle", "corner-radius": "10px",
        "background-color": (n) => TRACK_COLOR[n.data("track")] || "#5B7A5B",
        "background-gradient-stop-colors": (n) => { const c = TRACK_COLOR[n.data("track")] || "#5B7A5B"; return c + " " + c; },
        "label": "data(label)", "color": "#fff", "font-size": "12.5px", "font-weight": "600", "line-height": 1.3,
        "min-zoomed-font-size": 5,
        "text-outline-color": "#34402F", "text-outline-width": 1.1, "text-outline-opacity": 0.45,
        "text-wrap": "wrap", "text-max-width": (NODE_W - 20) + "px", "text-valign": "center", "text-halign": "center",
        "width": NODE_W + "px", "height": "data(h)", "padding": "5px", "border-width": 0, "z-index": 10,
        "transition-property": "opacity, border-width", "transition-duration": "0.15s" } },
      { selector: "node[kind='stub']", style: {
        "shape": "round-rectangle", "corner-radius": "7px",
        "label": "data(label)", "font-size": "9px", "font-weight": "700",
        "color": (n) => TRACK_COLOR[n.data("track")] || "#5B7A5B",
        "background-color": (n) => TRACK_COLOR[n.data("track")] || "#5B7A5B", "background-opacity": 0.14,
        "border-width": 1, "border-color": (n) => TRACK_COLOR[n.data("track")] || "#5B7A5B", "border-opacity": 0.55,
        "text-valign": "center", "text-halign": "center", "text-wrap": "none",
        "width": "label", "height": 16, "padding": "4px", "min-zoomed-font-size": 6, "z-index": 9,
        "transition-property": "opacity", "transition-duration": "0.15s" } },
      { selector: "node[kind='stub'].hover", style: { "background-opacity": 0.3, "border-opacity": 0.9 } },
      { selector: "node[kind='std'][?top]", style: {
        "border-width": 2.5, "border-color": "#2C342C", "font-weight": "800", "z-index": 12 } },
      { selector: "node[kind='std'][?starred]", style: { "border-width": 3, "border-color": "#E0C067", "z-index": 13 } },
      { selector: "node.untested", style: { "opacity": 0.4 } },
      { selector: "node[kind='unit']", style: {
        "label": "data(label)", "font-size": "11px", "font-weight": "800", "color": "#FBFAF6",
        "text-valign": "top", "text-halign": "center", "text-margin-y": -11,
        "text-background-color": "#7C8772", "text-background-opacity": 0.92,
        "text-background-shape": "round-rectangle", "text-background-padding": "5px",
        "background-color": "#FFFFFF", "background-opacity": 0.62, "border-width": 1.2, "border-color": "#D7DECE",
        "shape": "round-rectangle", "corner-radius": "12px", "padding": "12px", "z-index": 1 } },
      { selector: "node[kind='tier']", style: {
        "label": "data(label)", "font-size": "22px", "font-weight": "800", "color": "#9AA59A",
        "text-valign": "center", "text-halign": "right", "text-margin-x": -10,
        "background-opacity": 0, "border-width": 0, "width": 1, "height": 1, "events": "no", "z-index": 0 } },
      { selector: "node[kind='subject']", style: {
        "label": "data(label)", "font-size": "15px", "font-weight": "800", "color": "#2C342C",
        "text-valign": "top", "text-halign": "center", "text-margin-y": -6,
        "background-color": (n) => TRACK_COLOR[n.data("track")] || "#5B7A5B", "background-opacity": 0.08,
        "border-width": 1.5, "border-color": (n) => TRACK_COLOR[n.data("track")] || "#5B7A5B", "border-opacity": 0.4,
        "shape": "round-rectangle", "padding": "18px", "z-index": 0 } },
      { selector: "node.dim", style: { "opacity": 0.5 } },
      { selector: "node.hl", style: { "opacity": 1 } },
      { selector: "node.hover", style: { "border-width": 3, "border-color": "#5B7A5B", "z-index": 28 } },
      { selector: "node.sel", style: { "border-width": 3, "border-color": "#2C342C", "z-index": 30 } },
      { selector: "edge", style: {
        // A: 방향은 '색 그라데이션 테이퍼'(출발 옅게→도착 진하게)로 — 출발점 동그라미 제거(잡티 해소)
        "width": 1.8, "target-arrow-shape": "vee", "arrow-scale": 1.25,
        "line-fill": "linear-gradient", "line-gradient-stop-positions": "0% 100%",
        "line-gradient-stop-colors": "#CDD2C5 #8E947F", "target-arrow-color": "#8E947F",
        "curve-style": "unbundled-bezier", "control-point-weights": 0.5, "control-point-distances": 0,
        "target-distance-from-node": "7px", "source-distance-from-node": "1px",
        "display": "none", "opacity": 0.55, "line-cap": "round",
        "z-index": 6, "z-compound-depth": "auto" } },   // B: 평상시 선은 카드 뒤로
      // B: 짧은 간선은 화살촉 작게·끝 간격 좁게(비례 회복)
      { selector: "edge.shortedge", style: { "arrow-scale": 1.0, "target-distance-from-node": "5px", "source-distance-from-node": "0px" } },
      // F: 종류를 색뿐 아니라 선 형태로도 구분(색맹 대응) — 검수=실선, 초안=점선, 사용자=초록 실선
      // A: 각 종류도 그라데이션 테이퍼(옅게→진하게) 적용, 출발 마커 없음
      { selector: "edge.curated", style: { "line-style": "solid", "line-gradient-stop-colors": "#C7CCBC #7E8473", "target-arrow-color": "#7E8473", "width": 1.8, "opacity": 0.6 } },
      { selector: "edge.draft", style: { "line-style": "dashed", "line-fill": "solid", "line-color": "#A9A496", "target-arrow-color": "#A9A496", "width": 1.6, "opacity": 0.5 } },
      { selector: "edge.user", style: { "line-style": "solid", "line-gradient-stop-colors": "#A6BBA6 #4F6B4F", "target-arrow-color": "#4F6B4F", "width": 1.9, "opacity": 0.85 } },
      { selector: "edge.vis", style: { "display": "element" } },
      // E: 강조 경로는 "빛나는 길"(글로우) + 금색 그라데이션으로 흐름 방향 강조
      { selector: "edge.hl", style: { "display": "element", "width": 4.2,
        "line-gradient-stop-colors": "#F0D27A #C98A2E", "target-arrow-color": "#C98A2E",
        "opacity": 0.97, "line-cap": "round", "z-index": 40, "z-compound-depth": "top", "arrow-scale": 1.3,
        "underlay-color": "#E7C56A", "underlay-opacity": 0.45, "underlay-padding": 8 } },
      { selector: "edge.edgesel", style: { "display": "element", "width": 3.2, "line-fill": "solid", "line-color": "#C16A4E",
        "target-arrow-color": "#C16A4E", "opacity": 1, "z-index": 50, "z-compound-depth": "top" } },
      { selector: "node.pending", style: { "border-width": 4, "border-color": "#5B7A5B", "border-style": "dashed", "z-index": 30 } },
      { selector: "edge.hover", style: { "display": "element", "width": 3.4,
        "line-gradient-stop-colors": "#BCD3B8 #5B7A5B", "target-arrow-color": "#5B7A5B",
        "opacity": 0.92, "line-cap": "round", "z-index": 38, "z-compound-depth": "top",
        "underlay-color": "#A7C29B", "underlay-opacity": 0.4, "underlay-padding": 6 } },
      { selector: "edge.draftHidden", style: { "display": "none" } },
      { selector: "edge.faredge", style: { "width": 1.3, "opacity": 0.32, "line-style": "dotted", "line-fill": "solid", "line-color": "#B7AE9A", "target-arrow-color": "#B7AE9A" } }
    ];
  }

  function mount(el, graph, context) {
    g = graph; ctx = context; showAll = false; subjTree = null;
    cy = cytoscape({
      container: el, elements: buildElements(), style: style(),
      layout: { name: "preset", fit: false }, wheelSensitivity: 0.25, minZoom: 0.06, maxZoom: 2.5,
      autoungrabify: true   // 노드 드래그 이동 잠금 (팬/줌은 가능)
    });
    // 접기/펼치기: 과목·단원 묶음 노드에 큐 아이콘 (preset 위치 유지)
    if (cy.expandCollapse) {
      try {
        ec = cy.expandCollapse({ layoutBy: null, fisheye: false, animate: false, undoable: false,
          cueEnabled: true, expandCollapseCuePosition: "top-left", expandCollapseCueSize: 14 });
      } catch (e) { ec = null; }
    }
    cy.on("tap", "node[kind='std']", (ev) => {
      const id = ev.target.id();
      if (editMode) return onEditNodeTap(id);
      if (ctx.onSelect) ctx.onSelect(id);
    });
    cy.on("tap", "edge", (ev) => {
      const e = ev.target;
      if (!editMode) {   // 화살표 한 번 클릭 → 출발(선수) 성취기준 정보 미리보기 (이동 없음)
        if (ctx.onEdgeTap) ctx.onEdgeTap(e.data("source"), e.data("target"));
        return;
      }
      ev.originalEvent && ev.originalEvent.stopPropagation();
      cy.edges().removeClass("edgesel");
      e.addClass("edgesel");
      if (ctx.onSelectEdge) ctx.onSelectEdge(e.id(), e.data("source"), e.data("target"));
    });
    // 접힌 과목/단원 묶음을 클릭하면 펼침 (S1)
    cy.on("tap", "node[kind='subject'], node[kind='unit']", (ev) => {
      if (editMode || !ec) return;
      const n = ev.target;
      if (n.hasClass("cy-expand-collapse-collapsed-node")) { try { ec.expandRecursively(n); } catch (e) {} }
    });
    // 교과 간 선수개념 칩: 클릭하면 해당 과목으로 드릴다운(+선수개념 초점)
    cy.on("tap", "node[kind='stub']", (ev) => {
      if (editMode) return;
      const d = ev.target.data();
      if (ctx.onStubTap) ctx.onStubTap(d.toSubj, d.toPrereq);
    });
    cy.on("mouseover", "node[kind='stub']", (ev) => ev.target.addClass("hover"));
    cy.on("mouseout", "node[kind='stub']", (ev) => ev.target.removeClass("hover"));
    cy.on("tap", (ev) => {
      if (ev.target !== cy) return;
      if (editMode) { clearPending(); cy.edges().removeClass("edgesel"); if (ctx.onEditClear) ctx.onEditClear(); }
      else clearHighlight();
    });

    // 노드/단원 박스 위에서 드래그해도 화면이 따라 이동(pan)하도록 — 노드는 잠금이라 안 움직이고,
    // 빈 배경뿐 아니라 박스를 기점으로 잡아도 끌리게 한다. (탭=선택/연결, 드래그=이동)
    let panFrom = null;
    cy.on("tapstart", "node", (ev) => {
      const p = ev.renderedPosition || (ev.originalEvent && { x: ev.originalEvent.offsetX, y: ev.originalEvent.offsetY });
      if (p) panFrom = { x: p.x, y: p.y, pan: { x: cy.pan().x, y: cy.pan().y } };
    });
    cy.on("tapdrag", (ev) => {
      if (!panFrom) return;
      const p = ev.renderedPosition; if (!p) return;
      cy.pan({ x: panFrom.pan.x + (p.x - panFrom.x), y: panFrom.pan.y + (p.y - panFrom.y) });
    });
    cy.on("tapend", () => { panFrom = null; });

    // 더블클릭: 노드로 줌·초점 / 빈 배경은 전체 보기
    cy.on("dbltap", "node[kind='std']", (ev) => { if (!editMode) focusZoom(ev.target.id()); });
    // 화살표 더블클릭 → 그 선수개념(시작점)으로 이동·강조 (선수 거슬러 찾기)
    cy.on("dbltap", "edge", (ev) => {
      if (editMode) return;
      ev.originalEvent && ev.originalEvent.stopPropagation();
      const s = ev.target.source();
      if (ctx.onSelect) ctx.onSelect(s.id());
      cy.animate({ center: { eles: s }, zoom: Math.max(cy.zoom(), 0.7) }, { duration: 350 });
    });
    cy.on("dbltap", (ev) => { if (ev.target === cy) fitAll(); });

    // hover: 클릭 전에 그 개념의 직접 연결(선행·후속)만 살짝 미리보기
    cy.on("mouseover", "node[kind='std']", (ev) => {
      if (editMode) return;
      const n = ev.target; n.addClass("hover");
      n.connectedEdges("[?routed], edge").filter((e) => e.source().id() === n.id() || e.target().id() === n.id()).addClass("hover");
    });
    cy.on("mouseout", "node[kind='std']", (ev) => {
      ev.target.removeClass("hover");
      cy.edges(".hover").removeClass("hover");
    });

    cy.on("zoom", updateClusterLabels);
    cy.on("pan zoom", saveViewport);
    applyColors();
    updateClusterLabels();
    applyEdgeRoutes();
    if (ctx.onReady) ctx.onReady();
    return cy;
  }

  // 간선마다 통로 쪽으로 휘는 부드러운 곡선(control point) 적용
  function applyEdgeRoutes() {
    if (!cy) return;
    cy.edges("[routed]").forEach((e) => {
      e.style({ "curve-style": "unbundled-bezier", "control-point-weights": [0.5], "control-point-distances": [e.data("cpd") || 0] });
    });
  }

  function clearPending() { if (cy) cy.nodes().removeClass("pending"); pendingSrc = null; }

  function onEditNodeTap(id) {
    // 성취기준 간 연결은 블록 직접 클릭으로 만들지 않는다 — 노드 탭은 항상 '선택'만(수행능력 편집용).
    // (성취기준 화살표는 수행능력 선수관계 → deriveStdEdges 로만 생성)
    cy.nodes().removeClass("sel"); cy.$id(id).addClass("sel");
    if (ctx.onSelect) ctx.onSelect(id);
  }

  function setEditMode(on) {
    editMode = on; if (!cy) return;
    clearPending(); cy.edges().removeClass("edgesel");
    if (on) { cy.elements().removeClass("sel dim hl"); cy.edges().addClass("vis"); }
    else { cy.edges().removeClass("vis"); cy.nodes().removeClass("sel"); if (ctx.selId) highlight(ctx.selId); }
  }
  function setEditTab(t) { editTab = t; clearPending(); if (cy) cy.nodes().removeClass("sel"); }

  function wouldCycle(from, to) {   // from(선수)→to(상위) 추가 시 순환이면 true
    if (!cy) return false;
    return cy.$id(to).successors("node").anySame(cy.$id(from));
  }

  function addEdgeEl(from, to) {
    const id = "u" + (++edgeSeq);
    cy.add({ group: "edges", data: { id: id, source: from, target: to, user: true } })
      .addClass("user vis");
    return id;
  }
  function removeEdgeEl(id) { if (cy) cy.$id(id).remove(); }
  function removeEdgeByPair(from, to) {
    if (!cy) return;
    cy.edges().filter((e) => e.data("source") === from && e.data("target") === to).remove();
  }
  function restyleNode(id) {   // 중요표시 등 갱신
    if (!cy) return; const n = cy.$id(id);
    n.data("starred", g.node(id).starred);
  }

  function clearHighlight() {
    if (!cy) return;
    cy.elements().removeClass("sel dim hl");
    if (!showAll) cy.edges().removeClass("vis");
    ctx.selId = null;
  }

  function highlight(id) {
    if (!cy) return;
    const n = cy.$id(id); if (!n.length) return;
    ctx.selId = id;
    cy.elements().removeClass("sel dim hl vis");
    let chain = n.predecessors().union(n);                       // 선행(선수) 상류
    if (hlDownstream) chain = chain.union(n.successors());       // 후속(하류)까지
    cy.nodes("[kind='std']").not(chain).addClass("dim");
    chain.addClass("hl");
    chain.edges().addClass("vis hl");
    n.addClass("sel");
    if (showAll) cy.edges().addClass("vis");
  }
  function setHighlightDownstream(v) { hlDownstream = v; if (cy && ctx.selId) highlight(ctx.selId); }
  function panBy(dx, dy) { if (cy) cy.panBy({ x: dx, y: dy }); }
  // A7: 마지막으로 보던 위치(줌·이동) 기억/복원
  let vpTimer = null;
  function saveViewport() {
    if (!cy) return; clearTimeout(vpTimer);
    vpTimer = setTimeout(() => { try { localStorage.setItem("sage.viewport", JSON.stringify({ z: cy.zoom(), p: cy.pan() })); } catch (e) {} }, 300);
  }
  function restoreViewport() {
    if (!cy) return false;
    try { const v = JSON.parse(localStorage.getItem("sage.viewport")); if (v && v.z && v.p) { cy.zoom(v.z); cy.pan(v.p); return true; } } catch (e) {}
    return false;
  }

  function focus(id) {
    if (!cy) return;
    const n = cy.$id(id); if (!n.length) return;
    highlight(id);
    cy.animate({ center: { eles: n }, zoom: Math.max(0.8, cy.zoom()) }, { duration: 350 });
  }
  // 더블클릭 초점: 패널·강조 갱신 + 노드로 확대 이동
  function focusZoom(id) {
    if (!cy) return;
    const n = cy.$id(id); if (!n.length) return;
    if (ctx.onSelect) ctx.onSelect(id);
    cy.animate({ center: { eles: n }, zoom: Math.max(1.0, cy.zoom()) }, { duration: 350 });
  }
  // 줌아웃해도 과목/단원 이름이 읽히도록 화면상 글자 크기를 일정하게 유지
  function updateClusterLabels() {
    if (!cy) return; const z = cy.zoom();
    cy.nodes("[kind='subject']").style("font-size", Math.max(13, Math.min(64, 15 / z)) + "px");
    cy.nodes("[kind='unit']").style("font-size", Math.max(10, Math.min(40, 11 / z)) + "px");
  }
  // 검수된 선만 보기(자동 초안 숨김)
  function setVerifiedOnly(v) { verifiedOnly = v; if (cy) cy.edges(".draft").toggleClass("draftHidden", v); }

  function setShowAll(v) {
    showAll = v; if (!cy) return;
    if (v) {
      cy.edges().addClass("vis");
      cy.edges().forEach((e) => {   // 전체보기: 출발(선수) 개념의 학년색으로 선을 구분(그라데이션 테이퍼)
        const c = TRACK_COLOR[trackOf(e.data("source"))] || "#8E947F";
        if (e.style("line-fill") === "linear-gradient") e.style({ "line-gradient-stop-colors": lighten(c, 0.55) + " " + c, "target-arrow-color": c });
        else e.style({ "line-color": c, "target-arrow-color": c });
      });
    } else {
      cy.edges().forEach((e) => e.removeStyle("line-color line-gradient-stop-colors target-arrow-color source-arrow-color"));
      cy.edges().removeClass("vis");
      if (ctx.selId) highlight(ctx.selId);
    }
  }

  function masteryBar(color) {
    return "data:image/svg+xml;utf8," + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="9" height="44"><rect width="9" height="44" fill="' + color + '"/></svg>');
  }
  // 색 분리: 채움 = 과목(학년)색 항상 / 좌측 띠 = 도달도(진단 시)
  function applyColors() {
    if (!cy) return;
    const dx = ctx.dx;
    if (subjTree) {   // 과목 트리: 전체 개념트리와 같은 서식(연한 배경+진한 글씨)+단원색
      cy.nodes("[kind='std']").forEach((n) => {
        const c = subjTree.ucolor[subjTree.unitOf[n.id()]] || "#5B7A5B";
        n.style({ "background-color": lighten(c, 0.82), "background-opacity": 1, "background-image": "none",
          "border-width": 2.4, "border-color": c, "color": "#2C342C", "text-outline-width": 0 });
        n.removeClass("untested");
      });
      return;
    }
    cy.nodes("[kind='std']").forEach((n) => {
      n.style("background-color", TRACK_COLOR[n.data("track")] || "#5B7A5B");
      const m = dx ? dx.masteryOf(n.id()) : "none";
      if (dx && m !== "none") {
        n.style({ "background-image": masteryBar(SAGE.MASTERY[m].color), "background-width": "9px",
          "background-height": "100%", "background-position-x": "0", "background-position-y": "0",
          "background-fit": "none", "background-clip": "node", "background-image-opacity": 1 });
        n.removeClass("untested");
      } else {
        n.style("background-image", "none");
        if (dx) n.addClass("untested"); else n.removeClass("untested");
      }
    });
    // C4: 과목 박스 라벨에 도달도 % (진단 시)
    cy.nodes("[kind='subject']").forEach((s) => {
      const base = g.node(s.id()).name;
      if (!dx || !dx.results) { s.data("label", base); return; }
      let sum = 0, cnt = 0;
      g.standardsInSubject(s.id()).forEach((nd) => {
        if (dx.results[nd.id]) { sum += SAGE.MASTERY[dx.masteryOf(nd.id)].weight; cnt++; }
      });
      s.data("label", cnt ? base + " · " + Math.round(sum / cnt) + "%" : base);
    });
  }

  // 도달도 필터 + 핵심(★/최상위)만 보기를 통합 적용 (S6)
  let masteryActive = ["full", "partial", "weak", "none"], keyOnly = false;
  function applyVisibility() {
    if (!cy) return;
    cy.nodes("[kind='std']").forEach((n) => {
      let show = true;
      if (ctx.dx) show = masteryActive.indexOf(ctx.dx.masteryOf(n.id())) >= 0;
      if (show && keyOnly) show = !!(n.data("starred") || n.data("top"));
      n.style("display", show ? "element" : "none");
    });
  }
  function filterByMastery(active) { masteryActive = active; applyVisibility(); }
  function clearFilter() { masteryActive = ["full", "partial", "weak", "none"]; applyVisibility(); }
  function setKeyOnly(v) { keyOnly = v; applyVisibility(); }

  function searchMatches(q) {
    q = (q || "").trim().toLowerCase(); if (!q) return [];
    return g.nodesByType("standard").filter((n) =>
      (n.code || n.id).toLowerCase().indexOf(q) >= 0 || (n.name || "").toLowerCase().indexOf(q) >= 0
    ).map((n) => n.id);
  }

  function fitSubject(subjectId) {
    if (!cy) return; cy.stop();
    const s = cy.$id(subjectId);
    if (s && s.length) cy.animate({ fit: { eles: s.descendants().add(s), padding: 50 } }, { duration: 350 });
    else cy.animate({ fit: { eles: cy.nodes(), padding: 40 } }, { duration: 350 });
  }
  function fitAll() { if (cy) { cy.stop(); cy.animate({ fit: { eles: cy.nodes(), padding: 40 } }, { duration: 350 }); } }
  function zoomBy(f) { if (cy) cy.zoom({ level: cy.zoom() * f, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } }); }
  // ELK 자동 정렬(층 배치·교차 최소화). 학년 띠/라벨은 숨기고 노드만 재배치
  function runElk() {
    if (!cy) return false;
    if (typeof cy.layout !== "function") return false;
    cy.nodes("[kind='band'],[kind='tier']").style("display", "none");
    cy.edges("[routed]").removeStyle("curve-style control-point-distances control-point-weights");  // ELK 좌표용으로 곡선 라우팅 해제
    try {
      cy.layout({ name: "elk", fit: true, padding: 30,
        elk: { algorithm: "layered", "elk.direction": "DOWN", "elk.edgeRouting": "ORTHOGONAL",
          "elk.layered.spacing.nodeNodeBetweenLayers": 55, "spacing.nodeNode": 22 } }).run();
      return true;
    } catch (e) { cy.nodes("[kind='band'],[kind='tier']").style("display", "element"); return false; }
  }
  function collapseAllSubjects() { if (ec) try { ec.collapse(cy.nodes("[kind='subject']")); } catch (e) {} }
  function expandAllSubjects() { if (ec) try { ec.expandAll(); } catch (e) {} }
  // S1: 접힌 개요 — 모든 과목 접고 지정 과목만 펼침
  function collapseAllExcept(subjId) {
    if (!ec || !cy) return;
    try {
      ec.collapseAll();
      const s = subjId && cy.$id(subjId);
      if (s && s.length) ec.expandRecursively(s);
    } catch (e) {}
  }
  function expandSubject(subjId) { if (ec && cy) try { ec.expandRecursively(cy.$id(subjId)); } catch (e) {} }
  function hasExpandCollapse() { return typeof window.cytoscapeExpandCollapse !== "undefined"; }
  function hasElk() { return !!window.cytoscapeElk; }
  function hasTree() { return typeof window.cytoscapeDagre !== "undefined"; }
  // 단원 구별용 색 팔레트 (트리에선 단원 박스가 없으므로 색으로 구별)
  const UNIT_PALETTE = ["#5B7A5B", "#C08A4A", "#7E8BA3", "#A33C5B", "#6FA38E", "#8E7BA3", "#B5683C"];
  // S7: 한 과목을 선수관계 트리로 정렬 — 전체 개념트리와 같은 서식(연한 배경+진한 글씨)+단원별 색.
  function runSubjectTree(subjId) {
    if (!cy || typeof cy.layout !== "function") return false;
    const stds = cy.nodes("[subj='" + subjId + "'][kind='std']");
    if (!stds.length) return false;
    try {
      const units = []; const unitOf = {};
      stds.forEach((n) => { const u = n.data("parent"); unitOf[n.id()] = u; if (u && units.indexOf(u) < 0) units.push(u); });
      const ucolor = {}; units.forEach((u, i) => { ucolor[u] = UNIT_PALETTE[i % UNIT_PALETTE.length]; });
      subjTree = { ucolor: ucolor, unitOf: unitOf };
      cy.batch(() => { stds.forEach((n) => n.move({ parent: null })); });
      cy.elements().difference(stds).style("display", "none");
      const edges = stds.edgesWith(stds);
      edges.removeStyle("curve-style control-point-distances control-point-weights");
      stds.union(edges).style("display", "element");
      stds.union(edges).layout({ name: "dagre", rankDir: "TB", nodeSep: 14, rankSep: 54, edgeSep: 8, fit: true, padding: 40 }).run();
      applyColors();   // 단원색·텍스트 서식 (refreshWorkspace의 applyColors가 덮어쓰지 않도록 subjTree 기준으로 통일)
      edges.forEach((e) => {
        const c = ucolor[unitOf[e.data("source")]] || "#8E947F";
        e.style({ "line-fill": "linear-gradient", "line-gradient-stop-positions": "0% 100%",
          "line-gradient-stop-colors": lighten(c, 0.5) + " " + c, "target-arrow-color": c });
      });
      return true;
    } catch (e) { return false; }
  }

  // 미니맵: 읽기전용 오버뷰 + 현재 뷰포트 사각형
  function initMinimap(el, rectEl) {
    if (!cy || !el) return;
    mini = cytoscape({ container: el, elements: cy.elements("[kind='std'],[kind='subject']").jsons(),
      style: [
        { selector: "node[kind='std']", style: { "background-color": (n) => TRACK_COLOR[n.data("track")] || "#5B7A5B", "width": 158, "height": 44, "shape": "round-rectangle" } },
        { selector: "node[kind='subject']", style: { "background-opacity": 0.06, "border-width": 0 } }
      ],
      autolock: true, userZoomingEnabled: false, userPanningEnabled: false, boxSelectionEnabled: false, autoungrabify: true });
    mini.fit(mini.elements(), 6);
    const sync = () => {
      const e = cy.extent(), me = mini.extent(), mz = mini.zoom(), mp = mini.pan();
      const x = (e.x1 - me.x1) * mz + 0; // model→mini render
      // mini render coord = model*mz + pan
      const rx = e.x1 * mz + mp.x, ry = e.y1 * mz + mp.y;
      rectEl.style.left = rx + "px"; rectEl.style.top = ry + "px";
      rectEl.style.width = (e.w * mz) + "px"; rectEl.style.height = (e.h * mz) + "px";
    };
    cy.on("pan zoom resize", sync); sync();
    // 미니맵 클릭/드래그로 본 화면 이동(지도앱식)
    const jump = (ev) => {
      const r = el.getBoundingClientRect(), mz = mini.zoom(), mp = mini.pan();
      const mx = (ev.clientX - r.left - mp.x) / mz, my = (ev.clientY - r.top - mp.y) / mz; // model coords
      cy.pan({ x: cy.width() / 2 - mx * cy.zoom(), y: cy.height() / 2 - my * cy.zoom() });
    };
    let dragging = false;
    const onDown = (ev) => { dragging = true; jump(ev); ev.preventDefault(); };
    const onMove = (ev) => { if (dragging) jump(ev); };
    const onUp = () => { dragging = false; };
    el.addEventListener("mousedown", onDown);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    // 이전 미니맵의 window 리스너 정리(뷰 전환마다 누적되던 누수 차단)
    if (miniCleanup) miniCleanup();
    miniCleanup = () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); el.removeEventListener("mousedown", onDown); };
  }

  // 전체(수학) 교과 과목 트리: 16개 과목을 교과 간 선수관계로 연결해 한 화면 트리로
  function treeStyle() {
    return [
      { selector: "node[kind='treesubj']", style: {
        "shape": "round-rectangle", "corner-radius": "13px",
        "label": "data(label)", "width": 156, "height": 56,
        "background-color": "#FCFBF7", "background-opacity": 1,
        "border-width": 3, "border-color": (n) => TRACK_COLOR[n.data("track")] || "#5B7A5B",
        "color": "#2C342C", "font-size": "13px", "font-weight": "800", "line-height": 1.35,
        "text-valign": "center", "text-halign": "center", "text-wrap": "wrap", "text-max-width": "140px",
        "transition-property": "border-width, background-color", "transition-duration": "0.12s", "z-index": 10 } },
      { selector: "node.hover", style: { "border-width": 5, "background-color": "#F1F4EC", "z-index": 20 } },
      { selector: "node[kind='treetier']", style: {
        "label": "data(label)", "font-size": "15px", "font-weight": "800", "color": "#9AA59A",
        "text-valign": "center", "text-halign": "right", "text-margin-x": -12,
        "background-opacity": 0, "border-width": 0, "width": 1, "height": 1, "events": "no", "z-index": 0 } },
      { selector: "edge", style: {
        "width": (e) => Math.min(5.5, 1.4 + (e.data("n") || 1) * 0.28),
        "curve-style": "unbundled-bezier", "control-point-distances": (e) => (e.source().position("y") === e.target().position("y") ? -34 : 0), "control-point-weights": 0.5,
        "target-arrow-shape": "vee", "arrow-scale": 1.25,
        "line-fill": "linear-gradient", "line-gradient-stop-positions": "0% 100%",
        "line-gradient-stop-colors": "#CDD2C5 #8E947F", "target-arrow-color": "#8E947F",
        "target-distance-from-node": "4px", "opacity": 0.62, "line-cap": "round", "z-index": 4 } },
      { selector: "edge.hl", style: { "opacity": 0.95, "z-index": 30,
        "underlay-color": "#E7C56A", "underlay-opacity": 0.4, "underlay-padding": 5 } }
    ];
  }
  function mountSubjectTree(el, graph, context) {
    g = graph; ctx = context || {};
    const subjects = g.nodesByType("subject");
    const els = [];
    // 학년 띠(tier) 행으로 배치: 모든 과목이 자기 학년 줄에 놓이고, 선수관계 선이 위→아래로 흐른다
    const COL_W = 168, COL_GAP = 40, ROW_GAP = 132;
    const byTier = {};
    subjects.forEach((s) => { (byTier[s.track] = byTier[s.track] || []).push(s); });
    const rows = TIER_LIST.filter((t) => (byTier[t] || []).length);
    let maxRowW = 0;
    rows.forEach((t) => { const n = byTier[t].length; maxRowW = Math.max(maxRowW, n * COL_W + (n - 1) * COL_GAP); });
    const leftX = -maxRowW / 2 - 170;
    rows.forEach((t, ti) => {
      const list = byTier[t].sort((a, b) => a.id.localeCompare(b.id));
      const rowW = list.length * COL_W + (list.length - 1) * COL_GAP;
      const y = ti * ROW_GAP;
      els.push({ data: { id: "tlbl-" + t, kind: "treetier", label: TIER_LABEL[t] || t }, position: { x: leftX, y: y }, selectable: false, grabbable: false });
      let x = -rowW / 2 + COL_W / 2;
      list.forEach((s) => {
        const cnt = g.standardsInSubject(s.id).length;
        const pct = ctx.pctOf ? ctx.pctOf(s.id) : null;
        const label = s.name + "\n" + cnt + "개 성취기준" + (pct != null ? " · " + pct + "%" : "");
        els.push({ data: { id: s.id, label: label, kind: "treesubj", track: s.track }, position: { x: x, y: y } });
        x += COL_W + COL_GAP;
      });
    });
    const agg = {};
    g.edges.forEach((e) => {
      if (e.rel !== "prerequisite") return;
      const fs = subjectOf(e.from), ts = subjectOf(e.to);
      if (!fs || !ts || fs === ts) return;
      const k = fs + ">" + ts;
      (agg[k] = agg[k] || { from: fs, to: ts, n: 0 }).n++;
    });
    let i = 0;
    Object.keys(agg).forEach((k) => { const a = agg[k]; els.push({ data: { id: "tse" + (i++), source: a.from, target: a.to, n: a.n } }); });

    cy = cytoscape({
      container: el, elements: els, style: treeStyle(),
      layout: { name: "preset", fit: true, padding: 46 },
      wheelSensitivity: 0.25, minZoom: 0.2, maxZoom: 2.2, autoungrabify: true
    });
    // 각 선수관계를 '선수 과목'의 학년색 그라데이션으로 (전체보기 색 규칙과 통일)
    cy.edges().forEach((e) => {
      const c = TRACK_COLOR[(g.node(e.data("source")) || {}).track] || "#8E947F";
      e.style({ "line-gradient-stop-colors": lighten(c, 0.5) + " " + c, "target-arrow-color": c });
    });
    cy.on("tap", "node[kind='treesubj']", (ev) => { if (ctx.onPickSubject) ctx.onPickSubject(ev.target.id()); });
    cy.on("mouseover", "node[kind='treesubj']", (ev) => {
      const n = ev.target; n.addClass("hover"); n.connectedEdges().addClass("hl");
    });
    cy.on("mouseout", "node[kind='treesubj']", (ev) => { ev.target.removeClass("hover"); cy.edges(".hl").removeClass("hl"); });
    cy.on("dbltap", (ev) => { if (ev.target === cy) { cy.stop(); cy.fit(cy.nodes(), 46); } });
    if (ctx.onReady) ctx.onReady();
    return cy;
  }

  // 과목별 색 (트리에선 단원 묶음이 없으므로 과목을 색으로 구별)
  // 과목별 색: 8개 서로 다른 색상(hue)으로 명확히 구분 (파랑·초록·청록·노랑·주황·빨강·보라·자홍)
  const SUBJ_COLOR = {
    "9수": "#3F7FC4",   // 중학교 — 파랑
    "10공수1": "#3E9E5B", // 공통수학1 — 초록
    "10공수2": "#17A2A2", // 공통수학2 — 청록
    "12대수": "#D9A21B",  // 대수 — 노랑(골드)
    "12미적Ⅰ": "#E5702A", // 미적분Ⅰ — 주황
    "12미적Ⅱ": "#CE3B36", // 미적분Ⅱ — 빨강
    "12기하": "#8A4FCB",  // 기하 — 보라
    "확통": "#CC3F88"     // 확률과 통계 — 자홍
  };
  function conceptStyle() {
    const sc = (n) => SUBJ_COLOR[n.data("subj")] || "#5B7A5B";
    return [
      { selector: "node[kind='std']", style: {
        "shape": "round-rectangle", "corner-radius": "9px", "label": "data(label)",
        "background-color": (n) => lighten(sc(n), 0.78), "border-width": 2.4, "border-color": sc,
        "color": "#2C342C", "font-size": "11px", "font-weight": "700", "line-height": 1.25,
        "text-wrap": "wrap", "text-max-width": "150px", "text-valign": "center", "text-halign": "center",
        "width": 144, "text-max-width": "126px", "height": "label", "padding": "7px", "min-zoomed-font-size": 5,
        "transition-property": "opacity, border-width", "transition-duration": "0.12s", "z-index": 10 } },
      { selector: "node.dim", style: { "opacity": 0.28 } },
      { selector: "node.hl", style: { "opacity": 1, "z-index": 20 } },
      { selector: "node.hover", style: { "border-width": 4, "z-index": 26 } },
      { selector: "node.sel", style: { "border-width": 4, "border-color": "#2C342C", "z-index": 30 } },
      { selector: "edge", style: {
        "width": 1.8, "target-arrow-shape": "vee", "arrow-scale": 1.15, "curve-style": "bezier",
        "line-fill": "linear-gradient", "line-gradient-stop-positions": "0% 100%",
        "line-gradient-stop-colors": "#CDD2C5 #8E947F", "target-arrow-color": "#8E947F",
        "target-distance-from-node": "3px", "opacity": 0.4, "line-cap": "round",
        "display": "element", "z-index": 4 } },
      { selector: "edge.dim", style: { "opacity": 0.08 } },
      { selector: "edge.vis", style: { "display": "element" } },
      { selector: "edge.hl", style: { "width": 3.6, "opacity": 0.97, "z-index": 40,
        "line-gradient-stop-colors": "#F0D27A #C98A2E", "target-arrow-color": "#C98A2E",
        "underlay-color": "#E7C56A", "underlay-opacity": 0.4, "underlay-padding": 6 } },
      { selector: "edge.hover", style: { "width": 3, "opacity": 0.9, "z-index": 38,
        "line-gradient-stop-colors": "#BCD3B8 #5B7A5B", "target-arrow-color": "#5B7A5B" } }
    ];
  }
  function conceptLayout() {
    // 여백 최소화: 노드 간격·랭크 간격 축소 + tight-tree 랭커로 촘촘하게
    return { name: hasTree() ? "dagre" : "breadthfirst", rankDir: "TB", nodeSep: 12, rankSep: 110, edgeSep: 6, ranker: "tight-tree", fit: true, padding: 30, directed: true };
  }
  // 전체 개념 흐름 트리: 190개 성취기준을 선수관계로 이어 한 장의 트리로(과목별 색)
  function mountConceptTree(el, graph, context) {
    g = graph; ctx = context || {}; showAll = false; subjTree = null;
    const els = [];
    g.nodesByType("standard").forEach((s) => {
      els.push({ data: { id: s.id, label: s.name, kind: "std", subj: subjectOf(s.id) || "", track: trackOf(s.id),
        starred: !!s.starred, top: !!s.isTop } });
    });
    g.edges.forEach((e, i) => {
      if (e.rel !== "prerequisite") return;
      if (!g.node(e.from) || !g.node(e.to)) return;
      els.push({ data: { id: "ce" + i, source: e.from, target: e.to } });
    });
    cy = cytoscape({ container: el, elements: els, style: conceptStyle(),
      layout: conceptLayout(), wheelSensitivity: 0.25, minZoom: 0.05, maxZoom: 2.5, autoungrabify: true });
    // 간선을 선수(출발) 과목 색 그라데이션으로
    cy.edges().forEach((e) => {
      const c = SUBJ_COLOR[subjectOf(e.data("source"))] || "#8E947F";
      e.style({ "line-gradient-stop-colors": lighten(c, 0.5) + " " + c, "target-arrow-color": c });
    });
    cy.on("tap", "node[kind='std']", (ev) => { if (ctx.onSelect) ctx.onSelect(ev.target.id()); });
    cy.on("mouseover", "node[kind='std']", (ev) => {
      const n = ev.target; n.addClass("hover"); n.connectedEdges().addClass("hover");
    });
    cy.on("mouseout", "node[kind='std']", (ev) => { ev.target.removeClass("hover"); cy.edges(".hover").removeClass("hover"); });
    cy.on("tap", "edge", (ev) => {   // 한 번 클릭 → 출발(선수) 성취기준 미리보기
      const e = ev.target; if (ctx.onEdgeTap) ctx.onEdgeTap(e.data("source"), e.data("target"));
    });
    cy.on("tap", (ev) => { if (ev.target === cy) clearHighlight(); });
    // 화살표 더블클릭 → 선수개념(시작점)으로 이동·강조
    cy.on("dbltap", "edge", (ev) => {
      const s = ev.target.source();
      if (ctx.onSelect) ctx.onSelect(s.id());
      cy.animate({ center: { eles: s }, zoom: Math.max(cy.zoom(), 0.55) }, { duration: 350 });
    });
    cy.on("dbltap", (ev) => { if (ev.target === cy) { cy.stop(); cy.fit(cy.nodes(), 40); } });
    cy.on("zoom", updateClusterLabels);
    if (ctx.onReady) ctx.onReady();
    return cy;
  }
  // 범례에서 과목 클릭 → 그 과목 성취기준만 밝게, 나머지는 흐리게 (전체 개념 트리 전용)
  function highlightSubject(subj) {
    if (!cy) return;
    cy.elements().removeClass("sel dim hl");
    if (!subj) { if (!showAll) cy.edges().removeClass("vis"); return; }
    const inSubj = cy.nodes("[kind='std']").filter((n) => n.data("subj") === subj);
    if (!inSubj.length) return;
    cy.nodes("[kind='std']").not(inSubj).addClass("dim");
    inSubj.addClass("hl");
    cy.edges().addClass("dim");
    inSubj.edgesWith(inSubj).removeClass("dim").addClass("vis hl");
  }
  // "트리 정렬" — 현재 간선 기준으로 dagre 재배치 (교사가 연결 추가 후 정리)
  function relayoutTree() {
    if (!cy || typeof cy.layout !== "function") return;
    cy.stop();
    const lo = cy.layout(conceptLayout()); lo.run();
  }

  function unmount() { if (miniCleanup) { miniCleanup(); miniCleanup = null; } if (mini) { mini.destroy(); mini = null; } if (cy) { cy.destroy(); cy = null; } ec = null; }

  window.SAGE.GraphView = {
    mount, unmount, highlight, focus, setShowAll, applyColors, fitSubject, fitAll, zoomBy,
    setEditMode, setEditTab, wouldCycle, addEdgeEl, removeEdgeEl, removeEdgeByPair, restyleNode, clearPending,
    filterByMastery, clearFilter, setKeyOnly, searchMatches, focusZoom, setVerifiedOnly,
    setHighlightDownstream, panBy, clearHighlight, restoreViewport,
    runElk, runSubjectTree, mountSubjectTree, mountConceptTree, relayoutTree, highlightSubject, hasTree, collapseAllSubjects, expandAllSubjects, collapseAllExcept, expandSubject, hasExpandCollapse, hasElk, initMinimap,
    subjectColors: () => SUBJ_COLOR, subjectTreeColors: () => subjTree,
    get cy() { return cy; }, get showAll() { return showAll; }, get editMode() { return editMode; }, get verifiedOnly() { return verifiedOnly; }, get downstream() { return hlDownstream; }, get keyOnly() { return keyOnly; }
  };
})();
