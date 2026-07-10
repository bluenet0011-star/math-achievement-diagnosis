/* engine.js — 진단 상태 기계 (§5) */
(function () {
  "use strict";
  const { masteryFromRatio, MASTERY } = window.SAGE;

  // 활동의 채점 단위 배열(steps=stepwise · interactions=조작형) 통일 접근.
  function unitsOf(act) { return (act && (act.steps || act.interactions)) || []; }
  // 한 채점 단위가 입증하는 수행능력 id 목록 (skillIds 배열 또는 단일 skillId 모두 허용 — 다중 수행능력 지원)
  function skillIdsOf(unit) {
    if (!unit) return [];
    if (Array.isArray(unit.skillIds)) return unit.skillIds.filter(Boolean);
    return unit.skillId ? [unit.skillId] : [];
  }

  class Diagnosis {
    /* opts: { mode:'general'|'precise', subjectId, unitId } */
    constructor(graph, opts) {
      this.g = graph;
      this.opts = opts;
      this.queue = [];                 // 평가 대기 성취기준 id
      this.visited = new Set();        // 이미 큐에 넣은 id (중복 방지)
      this.results = {};               // standardId -> { ratio, mastery, stepResults, skipped, backtracked }
      this.skillResults = {};          // skillId -> 'pass'|'fail'
      this.path = [];                  // 실제 평가 순서(역추적 경로 기록)
      this.ptr = 0;
    }

    start() {
      let scope;
      if (this.opts.mode === "precise") {
        scope = this.g.standardsInSubject(this.opts.subjectId).map((n) => n.id);
      } else {
        scope = this.g.standardsInUnit(this.opts.unitId).map((n) => n.id);
      }
      this.scope = scope;
      const tops = this.g.topStandards(scope);
      tops.forEach((id) => this._enqueue(id));
      if (!this.queue.length) this._sweepOrphans();   // top들이 전부 활동 없음 → 범위 내 활동 보유 성취기준으로 시작
      return this;
    }

    _enqueue(id) {
      if (this.visited.has(id)) return;
      this.visited.add(id);
      if (this.g.activityFor(id)) { this.queue.push(id); return; }
      // 활동이 없는 성취기준은 측정하지 않되, 선수개념으로 계속 내려가 활동 있는 후손을 찾는다(하강 중단 금지)
      this.g.prerequisitesOf(id).forEach((pid) => this._enqueue(pid));
    }

    // 큐 소진 시: 범위 내에 있으면서 어떤 경로로도 닿지 않은 '고아' 성취기준(활동 보유)을 후순위로 측정
    _sweepOrphans() {
      (this.scope || []).forEach((id) => {
        if (!this.visited.has(id) && this.g.activityFor(id)) { this.visited.add(id); this.queue.push(id); }
      });
    }

    isDone() { return this.ptr >= this.queue.length; }

    current() {
      if (this.isDone()) return null;
      const id = this.queue[this.ptr];
      return { standardId: id, node: this.g.node(id), activity: this.g.activityFor(id) };
    }

    progress() {
      return { index: Math.min(this.ptr + 1, this.queue.length), total: this.queue.length };
    }

    // stepResults: ['pass'|'fail', ...] (활동 채점기가 반환)
    submit(stepResults) {
      const cur = this.current();
      if (!cur) return;
      const act = cur.activity;
      stepResults = Array.isArray(stepResults) ? stepResults : [];
      const attempted = stepResults.length > 0;            // C-3: step이 없으면 '미평가'
      const passed = stepResults.filter((r) => r === "pass").length;
      const ratio = attempted ? passed / stepResults.length : 0;
      const mastery = masteryFromRatio(ratio, attempted, stepResults.length);  // 미응시 → 'none' · 문항 수 반영(오답 1개 흡수)

      const units = unitsOf(act);
      stepResults.forEach((r, i) => {
        skillIdsOf(units[i]).forEach((sk) => { this.skillResults[sk] = r; });   // 한 조작 → 여러 수행능력
      });
      this.results[cur.standardId] = { ratio, mastery, stepResults, skipped: false };
      this.path.push(cur.standardId);

      // C-3: 'full'만 상향 가지치기. 'none'(빈 활동)은 결손이 아니므로 역추적도 하지 않음.
      if (mastery === "full") {
        this._pruneUp(cur.standardId);          // 상향 가지치기(B3)
      } else if (attempted) {
        this._backtrackSteps(cur.standardId, act, stepResults); // 결손 → step별 정밀 역추적(B5/C-1)
      }
      this.ptr++;
      if (this.isDone()) this._sweepOrphans();  // 적응 경로가 끝나면 범위 내 미도달 성취기준 회수
    }

    skip() {
      const cur = this.current();
      if (!cur) return;
      const act = cur.activity;
      const units = unitsOf(act);
      const stepResults = units.map(() => "skip");
      units.forEach((s) => { skillIdsOf(s).forEach((sk) => { this.skillResults[sk] = "skip"; }); });
      this.results[cur.standardId] = { ratio: 0, mastery: "weak", stepResults, skipped: true };
      this.path.push(cur.standardId);
      this._backtrack(cur.standardId);          // 포기 → 전체 역추적(B5)
      this.ptr++;
      if (this.isDone()) this._sweepOrphans();
    }

    _backtrack(standardId) {
      this.g.prerequisitesOf(standardId).forEach((pid) => this._enqueue(pid));
    }

    /* C-1: 틀린 step(수행능력)에 매핑된 선수개념만 역추적 (명세 B5 정밀화).
       계약 — 활동 step의 선택적 키 `prereq: [선수 standardId, ...]` (데이터는 B가 채움):
         · 통과(pass)한 step은 역추적하지 않는다.
         · 틀린 step에 prereq가 선언되어 있으면 그 선수개념만 큐에 넣되,
           계통도 간선(prerequisitesOf)에 실재하는 것으로 교차검증한다(단일 출처=간선, 교사 편집 반영).
         · 틀린 step에 prereq 선언이 없으면 해당 성취기준의 전체 선수개념으로 안전 폴백한다(기존 동작, 무회귀).
       skip(포기)은 step 정보가 없으므로 종전대로 _backtrack(전체)로 처리한다. */
    _backtrackSteps(standardId, activity, stepResults) {
      const steps = unitsOf(activity);
      const validPre = new Set(this.g.prerequisitesOf(standardId));
      const targeted = new Set();
      let needFull = false;
      stepResults.forEach((r, i) => {
        if (r === "pass") return;                 // 통과한 수행능력 → 역추적 없음
        const pr = steps[i] && steps[i].prereq;
        if (Array.isArray(pr) && pr.length) {
          pr.forEach((pid) => { if (validPre.has(pid)) targeted.add(pid); });
          return;
        }
        // prereq 미선언 → 수행능력 선수관계(skillPrereq)에서 파생: 틀린 미션의 skill → 그 선수 skill → 소속 성취기준
        let derived = false;
        skillIdsOf(steps[i]).forEach((sk) => {
          const pres = (window.SAGE.Edits && window.SAGE.Edits.skillPrereqsOf) ? window.SAGE.Edits.skillPrereqsOf(sk) : [];
          pres.forEach((psk) => {
            const pstd = String(psk).replace(/-[a-z]$/i, "");
            if (pstd !== standardId && validPre.has(pstd)) { targeted.add(pstd); derived = true; }
          });
        });
        if (!derived) needFull = true;            // 파생 불가 → 전체 폴백(무회귀)
      });
      if (needFull) this._backtrack(standardId);
      targeted.forEach((pid) => this._enqueue(pid));
    }

    // 완전 통과 시 선수개념을 '완전(추정)'으로 표시하고 큐에 넣지 않음
    _pruneUp(standardId) {
      const stack = [...this.g.prerequisitesOf(standardId)];
      while (stack.length) {
        const pid = stack.pop();
        if (this.visited.has(pid)) continue;
        if (!this.results[pid]) {
          this.results[pid] = { ratio: 1, mastery: "full", inferred: true, stepResults: [] };
          this.visited.add(pid);
          this.g.prerequisitesOf(pid).forEach((x) => stack.push(x));
        }
      }
    }

    masteryOf(standardId) {
      const r = this.results[standardId];
      return r ? r.mastery : "none";
    }

    report() {
      const tested = Object.keys(this.results);
      const vals = tested.map((id) => MASTERY[this.results[id].mastery].weight);
      const overall = vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : 0;

      const perStandard = this.path.map((id) => ({
        id,
        code: this.g.node(id).code,
        name: this.g.node(id).name,
        mastery: this.results[id].mastery,
        skipped: this.results[id].skipped
      }));

      // 보강 추천 = 가장 약한 성취기준. 동률이면 경로상 '나중'(=더 깊이 역추적된 선수개념)을 고른다 — 결손의 뿌리 우선.
      let rec = null, low = 999;
      this.path.forEach((id) => {
        const w = MASTERY[this.results[id].mastery].weight;
        if (w <= low) { low = w; rec = this.g.node(id); }
      });
      // 아무것도 측정하지 못한 진단(빈 경로)은 '모두 이해'가 아니다 — 모순 리포트 방지
      const allMastered = this.path.length > 0 && low >= MASTERY.full.weight;

      return { overall, perStandard, recommendation: allMastered ? null : rec, allMastered };
    }

    // localStorage 직렬화 (B9 이어하기)
    serialize() {
      return {
        opts: this.opts, queue: this.queue, visited: [...this.visited], scope: this.scope || [],
        results: this.results, skillResults: this.skillResults, path: this.path, ptr: this.ptr
      };
    }
    static restore(graph, data) {
      const d = new Diagnosis(graph, data.opts);
      d.queue = data.queue; d.visited = new Set(data.visited); d.scope = data.scope || [];
      d.results = data.results; d.skillResults = data.skillResults;
      d.path = data.path; d.ptr = data.ptr;
      return d;
    }
  }

  window.SAGE.Diagnosis = Diagnosis;
})();
