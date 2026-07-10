/* templates.js — 활동 유형 템플릿 (§6 공통 계약).

   ── 공개 계약 (모든 템플릿이 지켜야 함) ────────────────────────────────
   Templates[templateType] = {
     render(activity, host) : host 안에 문항 UI를 그린다. 사용자 입력 상태는
        activity._userInputs(임시) 등 activity에 보관(엔진은 건드리지 않음).
     grade(activity)        : 채점 후 { stepResults, passed } 반환.
        · stepResults : activity.steps와 같은 길이의 배열, 각 원소는 'pass'|'fail'.
          (엔진이 stepResults[i] ↔ activity.steps[i].skillId 로 수행능력에 매핑하고,
           틀린 step의 step.prereq로 정밀 역추적한다 — C-1/B5.)
        · passed      : 전체 통과 여부(보조 플래그, 판정은 엔진이 비율로 다시 계산).

   ── 활동 없는 성취기준 정책 (C-2) ─────────────────────────────────────
   activityFor(standardId)==null 이면 엔진이 큐에 넣지 않는다(=미평가, mastery 'none').
   교사가 data/activities/*.json + manifest에 활동을 추가하면(코드 수정 불필요)
   자동으로 진단 큐에 편입된다. 새 활동 유형은 위 render/grade 계약만 지키면
   아래 Templates 객체에 키 하나 추가하는 것으로 붙는다(엔진/앱 수정 불필요). */
(function () {
  "use strict";

  const Templates = {};

  /* stepwise: 과정(step) 배열을 순서대로 묻고, step마다 수행능력(skillId)에 매핑.
     input: 'number' | 'choice' */
  Templates.stepwise = {
    render(activity, host) {
      host.innerHTML = "";
      activity._userInputs = activity.steps.map(() => null);

      activity.steps.forEach((step, i) => {
        const card = document.createElement("div");
        card.className = "step-card";

        const q = document.createElement("div");
        q.className = "step-q";
        q.innerHTML = '<span class="step-num">' + (i + 1) + "</span>" +
          '<span class="step-skill">' + (step.skillName || "수행능력") + "</span>";
        const prompt = document.createElement("div");
        prompt.className = "step-prompt";
        appendMath(prompt, step.prompt);
        card.appendChild(q);
        card.appendChild(prompt);

        if (step.input === "choice") {
          const wrap = document.createElement("div");
          wrap.className = "choices";
          step.choices.forEach((c, ci) => {
            const b = document.createElement("button");
            b.type = "button";
            b.className = "choice";
            appendMath(b, c);
            b.onclick = () => {
              activity._userInputs[i] = ci;
              [...wrap.children].forEach((x) => x.classList.remove("sel"));
              b.classList.add("sel");
            };
            wrap.appendChild(b);
          });
          card.appendChild(wrap);
        } else {
          const inp = document.createElement("input");
          inp.type = "number";
          inp.className = "num-input";
          inp.placeholder = "답 입력";
          inp.inputMode = "numeric";
          inp.oninput = () => {
            activity._userInputs[i] = inp.value === "" ? null : Number(inp.value);
          };
          card.appendChild(inp);
        }
        host.appendChild(card);
      });
    },

    grade(activity) {
      const inputs = activity._userInputs || [];   // render 전 호출 등 방어
      const stepResults = (activity.steps || []).map((step, i) => {
        const ans = inputs[i];
        if (ans === null || ans === undefined) return "fail";
        return ans === step.answer ? "pass" : "fail";
      });
      return { stepResults, passed: stepResults.length > 0 && stepResults.every((r) => r === "pass") };
    }
  };

  /* ════════════════════════════════════════════════════════════════════
     interactive — 조작·구성형 활동 (단순 풀이 탈피).
     활동 = 도입 맥락(context) + 조작 단위(interactions[]) 의 나열.
     각 interaction:
       { id, kind, prompt, config, skillIds:[...], prereq?:[...], explain }
       · kind 는 아래 Kinds 레지스트리의 조작 부품 (재사용·일관 UI).
       · skillIds 는 이 조작이 "해내면 보유로 인정"되는 수행능력(복수=한 조작이 여러 능력 입증).
     grade: interaction 순서대로 pass/fail 배열 반환 → 엔진이 skillIds 전부에 매핑.
     ──────────────────────────────────────────────────────────────────── */
  const Kinds = {};
  function el(tag, cls, txt) { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
  function sameSet(a, b) { if (a.size !== b.size) return false; for (const x of a) if (!b.has(x)) return false; return true; }

  // 위/아래 분수 표기 (슬래시 금지) — a/b 형태를 실제 분수로 렌더
  function fracSpan(num, den) {
    const s = el("span", "frac");
    s.appendChild(el("span", "frac-num", String(num)));
    s.appendChild(el("span", "frac-den", String(den)));
    return s;
  }
  // 텍스트 안의 "a/b" 패턴을 위/아래 분수로 바꿔 host에 추가 (나머지는 그대로)
  function appendMath(host, text) {
    text = String(text == null ? "" : text);
    const re = /(-?\d+)\s*\/\s*(\d+)/g;
    let last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) host.appendChild(document.createTextNode(text.slice(last, m.index)));
      host.appendChild(fracSpan(m[1], m[2]));
      last = re.lastIndex;
    }
    if (last < text.length) host.appendChild(document.createTextNode(text.slice(last)));
    return host;
  }
  function mathEl(tag, cls, text) { return appendMath(el(tag, cls), text); }

  /* build-set: 칩을 골라 집합(표본공간·사건·값의 모임)을 직접 구성한다.
     config: { items:[{label,val}], target:[val,...], basketName } */
  Kinds["build-set"] = {
    render(ix, host, act) {
      const st = (act._ix[ix.id] = { picked: new Map() });   // val -> label
      const cfg = ix.config;
      const basket = el("div", "ix-basket");
      const basketLbl = el("div", "ix-basket-name", (cfg.basketName || "담는 곳") + " = {");
      const basketItems = el("span", "ix-basket-items");
      const basketEnd = el("span", "ix-basket-name", "}");
      basket.appendChild(basketLbl); basket.appendChild(basketItems); basket.appendChild(basketEnd);
      const pool = el("div", "ix-pool");
      function refresh() {
        basketItems.innerHTML = "";
        [...st.picked.values()].forEach((lab, i) => {
          basketItems.appendChild(appendMath(el("span", "ix-basket-chip"), lab));
        });
      }
      (cfg.items || []).forEach((it) => {
        const chip = el("button", "ix-chip"); appendMath(chip, it.label);
        chip.type = "button";
        chip.onclick = () => {
          const key = String(it.val);
          if (st.picked.has(key)) { st.picked.delete(key); chip.classList.remove("on"); }
          else { st.picked.set(key, it.label); chip.classList.add("on"); }
          refresh();
        };
        pool.appendChild(chip);
      });
      host.appendChild(basket); host.appendChild(pool);
      refresh();
    },
    grade(ix, act) {
      const st = act._ix[ix.id]; if (!st) return false;
      const picked = new Set([...st.picked.keys()]);
      const target = new Set((ix.config.target || []).map(String));
      return sameSet(picked, target);
    }
  };

  /* compute: 정의·공식을 적용해 값을 계산해 입력 (정수 답).
     config: { answer, unitLabel } */
  Kinds["compute"] = {
    render(ix, host, act) {
      const st = (act._ix[ix.id] = { raw: "" });
      const cfg = ix.config;
      const wrap = el("div", "ix-compute");
      if (cfg.prefix) wrap.appendChild(el("span", "ix-compute-fix", cfg.prefix));
      const inp = document.createElement("input");
      inp.className = "num-input"; inp.placeholder = "?";
      const numeric = (cfg.accept == null);   // accept(문자열 다답)면 비수치
      if (cfg.denominator != null) { inp.type = "number"; inp.inputMode = "numeric"; }   // 분수형: 분자(정수)
      else { inp.type = "text"; inp.inputMode = numeric ? "decimal" : "text"; inp.autocapitalize = "off"; inp.spellcheck = false; if (numeric) inp.title = "분수 1/2 또는 소수 0.5 모두 가능"; }
      inp.oninput = () => { st.raw = inp.value; };
      if (cfg.denominator != null) {
        const fr = el("span", "frac frac-input");
        const num = el("span", "frac-num"); num.appendChild(inp);
        fr.appendChild(num); fr.appendChild(el("span", "frac-den", String(cfg.denominator)));
        wrap.appendChild(fr);
      } else {
        wrap.appendChild(inp);
        if (cfg.suffix) wrap.appendChild(el("span", "ix-compute-fix", cfg.suffix));
      }
      host.appendChild(wrap);
    },
    grade(ix, act) {
      const st = act._ix[ix.id], cfg = ix.config;
      if (!st || st.raw == null || String(st.raw).trim() === "") return false;
      if (cfg.accept) { const v = normStr(st.raw); return [cfg.answer].concat(cfg.accept).some((a) => normStr(a) === v); }
      return numEq(parseFrac(st.raw), Number(cfg.answer), cfg.tol);   // 분수=소수=약분 모두 정답
    }
  };

  /* simulate: 시행을 직접 반복(주사위·동전 등)해 상대도수가 이론값에 가까워짐을 관찰한 뒤,
     이론적(수학적) 확률을 고른다. 탐구는 무작위, 채점은 이론값 판단으로 결정적.
     config: { trials, faces, success:[vals], question, choices, answer } */
  // 주사위 눈 6면 핍 배치 (3×3 격자 셀 인덱스)
  const DIE_PIPS = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
  function drawDie(die, v, faces) {
    die.innerHTML = "";
    if (faces === 6 && DIE_PIPS[v]) {
      const on = DIE_PIPS[v];
      for (let i = 0; i < 9; i++) { const cell = el("span", "die-cell"); if (on.indexOf(i) >= 0) cell.appendChild(el("span", "die-pip")); die.appendChild(cell); }
    } else { die.appendChild(el("span", "die-num", String(v))); }
  }

  Kinds["simulate"] = {
    render(ix, host, act) {
      const cfg = ix.config;
      const faces = cfg.faces || 6;
      const success = new Set((cfg.success || []).map(Number));
      const trials = cfg.trials || 60;
      const target = faces ? success.size / faces : 0;     // 이론적 확률 (수렴 목표선)
      const st = (act._ix[ix.id] = { n: 0, hits: 0, history: [], ran: false, choice: null });

      const panel = el("div", "ix-sim");
      // 주사위 + 굴리기 버튼
      const stage = el("div", "ix-sim-stage");
      const die = el("div", "ix-die"); drawDie(die, 1, faces);
      const btns = el("div", "ix-die-btns");
      const oneBtn = el("button", "ix-sim-roll", "🎲 한 번 굴리기"); oneBtn.type = "button";
      const autoBtn = el("button", "ix-sim-roll alt", "⚡ " + trials + "번 자동으로"); autoBtn.type = "button";
      btns.appendChild(oneBtn); btns.appendChild(autoBtn);
      stage.appendChild(die); stage.appendChild(btns);
      panel.appendChild(stage);

      // 실시간 통계 + 막대 + 상대도수 추이 그래프
      const stat = el("div", "ix-sim-stat"); stat.appendChild(document.createTextNode("아직 굴리지 않음"));
      const bar = el("div", "ix-sim-bar"); const fill = el("div", "ix-sim-fill"); bar.appendChild(fill);
      const sparkWrap = el("div", "ix-sim-spark");
      sparkWrap.innerHTML = '<svg viewBox="0 0 300 64" preserveAspectRatio="none"></svg>';
      const svg = sparkWrap.querySelector("svg");
      panel.appendChild(stat); panel.appendChild(bar); panel.appendChild(sparkWrap);

      // 질문 (충분히 굴린 뒤 공개)
      const qWrap = el("div", "ix-sim-q"); qWrap.style.display = "none";
      qWrap.appendChild(mathEl("div", "ix-sim-qtext", cfg.question || "이 사건의 수학적(이론적) 확률은?"));
      const choices = el("div", "choices");
      (cfg.choices || []).forEach((c, ci) => {
        const b = el("button", "choice"); appendMath(b, c); b.type = "button";
        b.onclick = () => { st.choice = ci; [...choices.children].forEach((x) => x.classList.remove("sel")); b.classList.add("sel"); };
        choices.appendChild(b);
      });
      qWrap.appendChild(choices); panel.appendChild(qWrap);
      host.appendChild(panel);

      const NS = "http://www.w3.org/2000/svg";
      function drawSpark() {
        const W = 300, H = 64;
        const ty = H - target * H;
        let html = '<line x1="0" y1="' + ty.toFixed(1) + '" x2="' + W + '" y2="' + ty.toFixed(1) +
          '" stroke="#C98A2E" stroke-width="1.4" stroke-dasharray="4 3"/>';
        if (st.history.length > 1) {
          const n = st.history.length;
          const pts = st.history.map((v, i) => (i / (n - 1) * W).toFixed(1) + "," + (H - v * H).toFixed(1)).join(" ");
          html += '<polyline points="' + pts + '" fill="none" stroke="#5B7A5B" stroke-width="2" stroke-linejoin="round"/>';
        }
        svg.innerHTML = html;
      }
      function updateUI(v) {
        die.classList.toggle("hit", success.has(v));
        const rf = st.n ? st.hits / st.n : 0;
        stat.innerHTML = "";
        stat.appendChild(document.createTextNode("시행 " + st.n + "회 · 성공 " + st.hits + "회 · 상대도수 "));
        stat.appendChild(fracSpan(st.hits, st.n || 1));
        stat.appendChild(document.createTextNode(" ≈ " + rf.toFixed(3)));
        fill.style.width = Math.round(rf * 100) + "%";
        drawSpark();
        if (st.n >= trials && !st.ran) { st.ran = true; qWrap.style.display = ""; }
      }
      function applyRoll(v) { st.n++; if (success.has(v)) st.hits++; st.history.push(st.hits / st.n); updateUI(v); }
      function setBusy(b) { oneBtn.disabled = b; autoBtn.disabled = b; }
      drawSpark();

      oneBtn.onclick = () => {                // 한 번: 굴러가는 텀블 애니메이션 후 착지
        setBusy(true);
        let frames = 9, last = 1;
        const iv = setInterval(() => {
          last = 1 + Math.floor(Math.random() * faces); drawDie(die, last, faces); die.classList.add("rolling");
          if (--frames <= 0) { clearInterval(iv); die.classList.remove("rolling"); applyRoll(last); setBusy(false); }
        }, 60);
      };
      autoBtn.onclick = () => {               // 자동: 빠르게 연속으로 굴리며 수렴 관찰
        setBusy(true);
        let remaining = trials;
        const iv = setInterval(() => {
          const v = 1 + Math.floor(Math.random() * faces); drawDie(die, v, faces); applyRoll(v);
          if (--remaining <= 0) { clearInterval(iv); setBusy(false); }
        }, 55);
      };
    },
    grade(ix, act) { const st = act._ix[ix.id]; return !!(st && st.ran && st.choice === ix.config.answer); }
  };

  /* pascal: 파스칼 삼각형의 빈칸을 '위 두 수의 합'으로 직접 채운다.
     config: { n: 4, blanks: ["3-1","3-2","4-1","4-2","4-3"] }  (r-c, 0부터) */
  function binom(r, c) { let v = 1; for (let i = 0; i < c; i++) v = v * (r - i) / (i + 1); return Math.round(v); }
  Kinds["pascal"] = {
    render(ix, host, act) {
      const st = (act._ix[ix.id] = { vals: {} });
      const n = ix.config.n, blanks = new Set(ix.config.blanks || []);
      const wrap = el("div", "ix-pascal");
      for (let r = 0; r <= n; r++) {
        const row = el("div", "pascal-row");
        for (let c = 0; c <= r; c++) {
          const key = r + "-" + c;
          if (blanks.has(key)) {
            const inp = document.createElement("input");
            inp.type = "number"; inp.className = "pascal-in"; inp.placeholder = "?"; inp.inputMode = "numeric";
            inp.oninput = () => { st.vals[key] = inp.value === "" ? null : Number(inp.value); };
            const cell = el("span", "pascal-cell blank"); cell.appendChild(inp); row.appendChild(cell);
          } else {
            row.appendChild(el("span", "pascal-cell given", String(binom(r, c))));
          }
        }
        wrap.appendChild(row);
      }
      host.appendChild(wrap);
    },
    grade(ix, act) {
      const st = act._ix[ix.id]; if (!st) return false;
      return (ix.config.blanks || []).every((k) => { const p = k.split("-"); return st.vals[k] === binom(+p[0], +p[1]); });
    }
  };

  Templates.interactive = {
    render(activity, host) {
      host.innerHTML = "";
      activity._ix = {};
      const ctx = activity.context;
      if (ctx && (ctx.story || ctx.goal)) {
        const intro = el("div", "ix-intro");
        if (ctx.story) intro.appendChild(el("div", "ix-story", ctx.story));
        if (ctx.goal) intro.appendChild(el("div", "ix-goal", "🎯 " + ctx.goal));
        host.appendChild(intro);
      }
      (activity.interactions || []).forEach((ix, i) => {
        const card = el("div", "ix-card");
        const head = el("div", "ix-head");
        head.appendChild(el("span", "ix-num", String(i + 1)));
        (ix.skillNames || []).forEach((nm) => head.appendChild(el("span", "ix-skill", nm)));
        card.appendChild(head);
        if (ix.prompt) card.appendChild(mathEl("div", "ix-prompt", ix.prompt));
        const body = el("div", "ix-body");
        const kind = Kinds[ix.kind];
        if (kind) kind.render(ix, body, activity);
        else body.appendChild(el("div", "ix-prompt", "(알 수 없는 조작 유형: " + ix.kind + ")"));
        card.appendChild(body);
        host.appendChild(card);
      });
    },
    grade(activity) {
      const ixs = activity.interactions || [];
      const stepResults = ixs.map((ix) => {
        const kind = Kinds[ix.kind];
        return kind && kind.grade(ix, activity) ? "pass" : "fail";
      });
      return { stepResults, passed: stepResults.length > 0 && stepResults.every((r) => r === "pass") };
    },
    // 스텝형: 활동의 단일 미션(interaction)만 렌더. act._ix는 누적 유지(현재 미션만 새로 세팅됨).
    renderOne(activity, host, index) {
      host.innerHTML = "";
      activity._ix = activity._ix || {};
      const ix = (activity.interactions || [])[index];
      if (!ix) return;
      const card = el("div", "ix-card");
      const head = el("div", "ix-head");
      head.appendChild(el("span", "ix-num", String(index + 1)));
      (ix.skillNames || []).forEach((nm) => head.appendChild(el("span", "ix-skill", nm)));
      card.appendChild(head);
      if (ix.prompt) card.appendChild(mathEl("div", "ix-prompt", ix.prompt));
      const body = el("div", "ix-body");
      const kind = Kinds[ix.kind];
      if (kind) kind.render(ix, body, activity); else body.appendChild(el("div", "ix-prompt", "(알 수 없는 조작 유형: " + ix.kind + ")"));
      card.appendChild(body); host.appendChild(card);
    },
    // 스텝형: 단일 미션 채점
    gradeOne(activity, index) {
      const ix = (activity.interactions || [])[index]; const kind = ix && Kinds[ix.kind];
      return !!(kind && kind.grade(ix, activity));
    }
  };

  function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; } return a; }
  function normStr(x) { return String(x == null ? "" : x).replace(/\s/g, ""); }
  // 분수("1/2")·소수("0.5")·정수 → 숫자. 못 읽으면 NaN
  function parseFrac(s) { s = String(s == null ? "" : s).trim().replace(/\s/g, ""); if (s === "") return NaN; if (/^[-+]?\d+\/[-+]?\d+$/.test(s)) { const p = s.split("/"); return Number(p[0]) / Number(p[1]); } return Number(s); }
  function numEq(a, b, tol) { return isFinite(a) && isFinite(b) && Math.abs(a - b) <= (tol == null ? 1e-9 : tol); }
  // 암시적 곱(2x, 2(x+1), )(  )을 명시(*)로 — math.js 파싱용
  function normExpr(s) {
    s = String(s == null ? "" : s).replace(/×/g, "*").replace(/÷/g, "/").replace(/\s+/g, "");
    s = s.replace(/(\d)([a-zA-Z(])/g, "$1*$2");          // 2x, 2(  → 2*x, 2*(
    s = s.replace(/(\))([a-zA-Z0-9(])/g, "$1*$2");        // )x, )2, )(  → )*…
    s = s.replace(/(^|[^a-zA-Z])([a-zA-Z])\(/g, "$1$2*("); // x( → x*(  (sin(·cos( 등 함수명은 보존)
    return s;
  }
  // 두 식이 대수적으로 같은가 — 여러 점에서 수치 평가해 일치하면 동치(라이브러리 없으면 문자열 비교)
  function exprEqual(stu, ans) {
    if (typeof math === "undefined") return normStr(stu).toLowerCase() === normStr(ans).toLowerCase();
    const A = normExpr(ans), B = normExpr(stu); if (!B) return false;
    const vars = ["x", "y", "a", "b", "n", "t", "r", "k"], pts = [1.3, 2.7, 0.6, 3.1, 1.9, 2.2];
    try {
      for (let i = 0; i < pts.length; i++) {
        const scope = {}; vars.forEach((v, j) => { scope[v] = pts[(i + j) % pts.length] + j * 0.13; });
        const av = math.evaluate(A, scope), bv = math.evaluate(B, scope);
        if (typeof av !== "number" || typeof bv !== "number") return false;
        if (Math.abs(av - bv) > 1e-6) return false;
      }
      return true;
    } catch (e) { return normStr(stu).toLowerCase() === normStr(ans).toLowerCase(); }
  }
  function insertAtCaret(inp, text) {
    const s = inp.selectionStart || inp.value.length, e = inp.selectionEnd || inp.value.length;
    inp.value = inp.value.slice(0, s) + text + inp.value.slice(e);
    const pos = s + text.length; inp.setSelectionRange(pos, pos);
  }

  /* drag-match: 왼쪽 항목에 알맞은 오른쪽(정의·예시·상황)을 골라 짝짓는다.
     config: { pairs:[{left, right}] }  (right = 정답 짝, 보기는 right들을 섞어 제시) */
  Kinds["drag-match"] = {
    render(ix, host, act) {
      const pairs = ix.config.pairs || [];
      const st = (act._ix[ix.id] = { sel: {} });
      const opts = shuffle(pairs.map((p) => p.right).slice());
      const wrap = el("div", "ix-match");
      pairs.forEach((p, i) => {
        const row = el("div", "match-row");
        row.appendChild(appendMath(el("span", "match-left"), p.left));
        const sel = document.createElement("select"); sel.className = "match-sel";
        const ph = document.createElement("option"); ph.value = ""; ph.textContent = "— 고르기 —"; sel.appendChild(ph);
        opts.forEach((o) => { const op = document.createElement("option"); op.value = o; op.textContent = o; sel.appendChild(op); });
        sel.onchange = () => { st.sel[i] = sel.value; };
        row.appendChild(sel); wrap.appendChild(row);
      });
      host.appendChild(wrap);
    },
    grade(ix, act) { const st = act._ix[ix.id]; return (ix.config.pairs || []).every((p, i) => st.sel[i] === p.right); }
  };

  /* order-seq: 항목을 올바른 순서대로 눌러 나열한다 (과정·증명·단계).
     config: { items:[{label,val}], order:[val,...] } */
  Kinds["order-seq"] = {
    render(ix, host, act) {
      const items = ix.config.items || [];
      const st = (act._ix[ix.id] = { seq: [] });
      const wrap = el("div", "ix-order");
      const seqBar = el("div", "order-seq-bar");
      const pool = el("div", "order-pool");
      function refresh() {
        seqBar.innerHTML = "";
        st.seq.forEach((v, i) => { const it = items.find((x) => String(x.val) === String(v)); seqBar.appendChild(appendMath(el("span", "order-chip"), (i + 1) + ". " + (it ? it.label : v))); });
        [...pool.children].forEach((b) => b.classList.toggle("used", st.seq.map(String).indexOf(b.getAttribute("data-v")) >= 0));
      }
      shuffle(items.slice()).forEach((it) => {
        const b = el("button", "order-item"); appendMath(b, it.label); b.type = "button"; b.setAttribute("data-v", String(it.val));
        b.onclick = () => { const k = String(it.val), idx = st.seq.map(String).indexOf(k); if (idx >= 0) st.seq.splice(idx, 1); else st.seq.push(it.val); refresh(); };
        pool.appendChild(b);
      });
      wrap.appendChild(el("div", "order-hint", "순서대로 누르세요 · 다시 누르면 취소"));
      wrap.appendChild(seqBar); wrap.appendChild(pool); host.appendChild(wrap); refresh();
    },
    grade(ix, act) { const st = act._ix[ix.id], order = ix.config.order || []; return st.seq.length === order.length && st.seq.every((v, i) => String(v) === String(order[i])); }
  };

  /* fill-table: 표의 빈칸을 채운다 (확률분포표·도수분포표 등).
     config: { headers:[...], rows:[[cell,...],...], blanks:["r-c",...], answers:{"r-c":값} }  (r,c는 rows 기준 0부터) */
  // 빈칸 키를 (행,열)로 해석 — "0-1", "r0-1" 두 형식 모두 허용
  function ftPos(k) { const m = String(k).replace(/^r/i, "").match(/(\d+)\s*-\s*(\d+)/); return m ? (m[1] + "-" + m[2]) : null; }
  Kinds["fill-table"] = {
    render(ix, host, act) {
      const cfg = ix.config, blanks = cfg.blanks || [], rows = cfg.rows || [];
      const st = (act._ix[ix.id] = { cells: {} });
      // 셀 값이 빈칸키로 쓰인 경우(플레이스홀더 관례) 우선. 그렇지 않은 키만 (행-열) 인덱스로 해석 → 입력칸 중복 방지.
      const cellVals = new Set(); rows.forEach((row) => row.forEach((c) => cellVals.add(String(c))));
      const pos2key = {};
      blanks.forEach((k) => { if (cellVals.has(k)) return; const p = ftPos(k); if (p) pos2key[p] = k; });
      const table = el("table", "ix-table");
      if (cfg.headers) { const tr = el("tr"); cfg.headers.forEach((hd) => { const th = document.createElement("th"); appendMath(th, String(hd)); tr.appendChild(th); }); table.appendChild(tr); }
      rows.forEach((row, r) => {
        const tr = el("tr");
        row.forEach((cell, c) => {
          const td = document.createElement("td");
          let bkey = (blanks.indexOf(String(cell)) >= 0) ? String(cell) : pos2key[r + "-" + c];   // 셀-값 매칭 우선
          if (bkey) { const inp = document.createElement("input"); inp.type = "text"; inp.className = "table-in"; inp.placeholder = "?"; inp.oninput = () => { st.cells[bkey] = inp.value; }; td.appendChild(inp); }
          else appendMath(td, String(cell));
          tr.appendChild(td);
        });
        table.appendChild(tr);
      });
      host.appendChild(table);
    },
    grade(ix, act) {
      const st = act._ix[ix.id], ans = ix.config.answers || {}, acc = ix.config.accept || {};
      return Object.keys(ans).every((k) => {
        const stu = st.cells[k], correct = ans[k];
        if (acc[k] && [correct].concat(acc[k]).some((a) => normStr(a) === normStr(stu))) return true;
        const sf = parseFrac(stu), cf = parseFrac(correct);
        if (isFinite(sf) && isFinite(cf) && numEq(sf, cf)) return true;   // 1/2 = 0.5 = 2/4
        return normStr(stu) === normStr(correct);
      });
    }
  };

  /* expr: 식을 입력해 답한다 (간이 수식 입력기 + 대수적 동치 채점).
     config: { answer:"x^2+2x+1", accept?:[다른 정답형], palette?:[기호버튼], placeholder? } */
  Kinds["expr"] = {
    render(ix, host, act) {
      const cfg = ix.config, st = (act._ix[ix.id] = { value: "" });
      const wrap = el("div", "ix-expr");
      const inp = document.createElement("input");
      inp.type = "text"; inp.className = "expr-input"; inp.placeholder = cfg.placeholder || "식 입력 (예: x^2+2x+1)";
      inp.autocapitalize = "off"; inp.spellcheck = false; inp.autocomplete = "off";
      inp.oninput = () => { st.value = inp.value; };
      wrap.appendChild(inp);
      const pal = cfg.palette || ["x", "y", "n", "^", "(", ")", "+", "−", "×", "÷"];
      const MAP = { "−": "-", "×": "*", "÷": "/" };
      const bar = el("div", "expr-pal");
      pal.forEach((tok) => {
        const b = el("button", "expr-key", tok); b.type = "button";
        b.onclick = () => { insertAtCaret(inp, MAP[tok] || tok); st.value = inp.value; inp.focus(); };
        bar.appendChild(b);
      });
      wrap.appendChild(bar);
      host.appendChild(wrap);
    },
    grade(ix, act) {
      const st = act._ix[ix.id]; if (!st || !String(st.value).trim()) return false;
      return [ix.config.answer].concat(ix.config.accept || []).some((a) => exprEqual(st.value, a));
    }
  };

  function svgLine(x1, y1, x2, y2, c, w, dash) { return '<line x1="' + x1.toFixed(1) + '" y1="' + y1.toFixed(1) + '" x2="' + x2.toFixed(1) + '" y2="' + y2.toFixed(1) + '" stroke="' + c + '" stroke-width="' + w + '"' + (dash ? ' stroke-dasharray="5 4"' : '') + '/>'; }

  /* slider: 매개변수를 슬라이더로 조절해 그래프/값을 목표에 맞춰 '구성'한다.
     config: { sliders:[{key,label,min,max,step,init,target}], preview?:{expr,x:[min,max],y:[min,max]}, tolerance? } */
  Kinds["slider"] = {
    render(ix, host, act) {
      const cfg = ix.config, sliders = cfg.sliders || [], pv = cfg.preview;
      const st = (act._ix[ix.id] = { vals: {} });
      sliders.forEach((s) => { st.vals[s.key] = s.init != null ? s.init : s.min; });
      const wrap = el("div", "ix-slider");
      let svg = null;
      if (pv) { const box = el("div", "slider-preview"); box.innerHTML = '<svg viewBox="0 0 320 200" preserveAspectRatio="none"></svg>'; svg = box.querySelector("svg"); wrap.appendChild(box); }
      const ctrls = el("div", "slider-ctrls");
      sliders.forEach((s) => {
        const row = el("div", "slider-row");
        row.appendChild(el("span", "slider-label", s.label || s.key));
        const inp = document.createElement("input"); inp.type = "range"; inp.className = "slider-range";
        inp.min = s.min; inp.max = s.max; inp.step = s.step || 1; inp.value = st.vals[s.key];
        const val = el("span", "slider-val", String(st.vals[s.key]));
        inp.oninput = () => { st.vals[s.key] = Number(inp.value); val.textContent = inp.value; draw(); };
        row.appendChild(inp); row.appendChild(val); ctrls.appendChild(row);
      });
      wrap.appendChild(ctrls); host.appendChild(wrap);
      function curve(expr, scope, color, dash) {
        const W = 320, H = 200, xr = pv.x || [-6.5, 6.5], yr = pv.y || [-4, 4], N = 140, pts = [];
        const X = (x) => (x - xr[0]) / (xr[1] - xr[0]) * W, Y = (y) => H - (y - yr[0]) / (yr[1] - yr[0]) * H;
        for (let i = 0; i <= N; i++) { const x = xr[0] + (xr[1] - xr[0]) * i / N; let y; try { y = (typeof math !== "undefined") ? math.evaluate(normExpr(expr), Object.assign({ x: x }, scope)) : NaN; } catch (e) { y = NaN; } if (typeof y !== "number" || !isFinite(y) || y < yr[0] - 2 || y > yr[1] + 2) { continue; } pts.push(X(x).toFixed(1) + "," + Y(y).toFixed(1)); }
        return '<polyline points="' + pts.join(" ") + '" fill="none" stroke="' + color + '" stroke-width="2.4"' + (dash ? ' stroke-dasharray="5 4"' : '') + '/>';
      }
      function draw() {
        if (!svg || !pv) return;
        const W = 320, H = 200, xr = pv.x || [-6.5, 6.5], yr = pv.y || [-4, 4];
        const X = (x) => (x - xr[0]) / (xr[1] - xr[0]) * W, Y = (y) => H - (y - yr[0]) / (yr[1] - yr[0]) * H;
        let html = svgLine(0, Y(0), W, Y(0), "#C9D2BF", 1) + svgLine(X(0), 0, X(0), H, "#C9D2BF", 1);
        const tscope = {}; sliders.forEach((s) => { tscope[s.key] = s.target; });
        if (pv.showTarget !== false) html += curve(pv.expr, tscope, "#C98A2E", true);   // 목표(점선)
        const scope = {}; sliders.forEach((s) => { scope[s.key] = st.vals[s.key]; });
        html += curve(pv.expr, scope, "#5B7A5B", false);                                 // 현재(실선)
        svg.innerHTML = html;
      }
      draw();
    },
    grade(ix, act) {
      const st = act._ix[ix.id], sliders = ix.config.sliders || [], tol = ix.config.tolerance;
      return sliders.every((s) => Math.abs(st.vals[s.key] - s.target) <= ((s.step || 1) / 2 + (tol == null ? 1e-9 : tol)));
    }
  };

  /* grid-plot: 좌표평면 격자점을 눌러 점을 찍어 그래프/수열/해집합을 '구성'한다.
     config: { x:[min,max], y:[min,max], target:[[x,y],...], guideExpr? } */
  Kinds["grid-plot"] = {
    render(ix, host, act) {
      const cfg = ix.config, xr = cfg.x || [0, 6], yr = cfg.y || [0, 6];
      const st = (act._ix[ix.id] = { pts: new Set() });
      const W = 340, H = 260, padL = 26, padB = 24;
      const X = (x) => padL + (x - xr[0]) / (xr[1] - xr[0]) * (W - padL - 6);
      const Y = (y) => (H - padB) - (y - yr[0]) / (yr[1] - yr[0]) * (H - padB - 6);
      const box = el("div", "ix-grid"); box.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '"></svg>'; const svg = box.querySelector("svg");
      function redraw() {
        let html = "";
        for (let gx = xr[0]; gx <= xr[1]; gx++) html += svgLine(X(gx), Y(yr[0]), X(gx), Y(yr[1]), "#EBF0E5", 1);
        for (let gy = yr[0]; gy <= yr[1]; gy++) html += svgLine(X(xr[0]), Y(gy), X(xr[1]), Y(gy), "#EBF0E5", 1);
        if (yr[0] <= 0 && yr[1] >= 0) html += svgLine(X(xr[0]), Y(0), X(xr[1]), Y(0), "#9DB39A", 1.5);
        if (xr[0] <= 0 && xr[1] >= 0) html += svgLine(X(0), Y(yr[0]), X(0), Y(yr[1]), "#9DB39A", 1.5);
        for (let gx = xr[0]; gx <= xr[1]; gx++) for (let gy = yr[0]; gy <= yr[1]; gy++) {
          const k = gx + "," + gy, on = st.pts.has(k);
          html += '<circle cx="' + X(gx) + '" cy="' + Y(gy) + '" r="' + (on ? 6 : 3.2) + '" fill="' + (on ? "#5B7A5B" : "#D5DDCB") + '"/>';
          html += '<circle cx="' + X(gx) + '" cy="' + Y(gy) + '" r="11" fill="transparent" data-k="' + k + '" style="cursor:pointer"/>';
        }
        svg.innerHTML = html;
      }
      svg.addEventListener("click", (e) => { const k = e.target && e.target.getAttribute && e.target.getAttribute("data-k"); if (!k) return; if (st.pts.has(k)) st.pts.delete(k); else st.pts.add(k); redraw(); });
      host.appendChild(box); redraw();
    },
    grade(ix, act) { const st = act._ix[ix.id]; const target = new Set((ix.config.target || []).map((p) => p[0] + "," + p[1])); return sameSet(st.pts, target); }
  };

  /* montecarlo: 정사각형에 무작위 다트를 던져 사분원 넓이비로 π(또는 기하적 확률)를 직접 추정·관찰한다.
     config: { need?:500, question, choices:[..], answer:idx } */
  Kinds["montecarlo"] = {
    render(ix, host, act) {
      const cfg = ix.config, W = 260, need = cfg.need || 500;
      const st = (act._ix[ix.id] = { n: 0, inside: 0, hist: [], pts: [], ran: false, choice: null });
      const wrap = el("div", "ix-mc");
      const row = el("div", "mc-row");
      const stage = el("div", "mc-stage"); stage.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + W + '" class="mc-svg"></svg>'; const svg = stage.querySelector("svg");
      const side = el("div", "mc-side");
      const stat = el("div", "mc-stat");
      const spark = el("div", "mc-spark"); spark.innerHTML = '<svg viewBox="0 0 200 80" preserveAspectRatio="none"></svg>'; const ssvg = spark.querySelector("svg");
      side.appendChild(stat); side.appendChild(spark);
      row.appendChild(stage); row.appendChild(side); wrap.appendChild(row);
      const btns = el("div", "mc-btns");
      [["🎯 다트 1개", 1], ["⚡ 100개", 100], ["⚡ 1000개", 1000]].forEach((kv) => { const b = el("button", "ix-sim-roll" + (kv[1] > 1 ? " alt" : ""), kv[0]); b.type = "button"; b.onclick = () => throwN(kv[1]); btns.appendChild(b); });
      wrap.appendChild(btns);
      const qWrap = el("div", "ix-sim-q"); qWrap.style.display = "none";
      qWrap.appendChild(mathEl("div", "ix-sim-qtext", cfg.question || "다트가 사분원 안에 들어갈 확률(= 넓이의 비)은?"));
      const choices = el("div", "choices");
      (cfg.choices || []).forEach((c, ci) => { const b = el("button", "choice"); appendMath(b, c); b.type = "button"; b.onclick = () => { st.choice = ci; [...choices.children].forEach((x) => x.classList.remove("sel")); b.classList.add("sel"); }; choices.appendChild(b); });
      qWrap.appendChild(choices); wrap.appendChild(qWrap);
      host.appendChild(wrap);
      const X = (x) => x * W, Y = (y) => (1 - y) * W;
      function draw() {
        let s = '<rect x="0.5" y="0.5" width="' + (W - 1) + '" height="' + (W - 1) + '" fill="#FBFCFA" stroke="#C9D2BF" stroke-width="1.4"/>';
        s += '<path d="M ' + X(0) + ' ' + Y(1) + ' A ' + W + ' ' + W + ' 0 0 1 ' + X(1) + ' ' + Y(0) + ' L ' + X(0) + ' ' + Y(0) + ' Z" fill="rgba(91,122,91,0.10)" stroke="#5B7A5B" stroke-width="1.6"/>';
        for (let i = 0; i < st.pts.length; i++) { const p = st.pts[i]; s += '<circle cx="' + X(p[0]).toFixed(1) + '" cy="' + Y(p[1]).toFixed(1) + '" r="1.7" fill="' + (p[2] ? "#3E7D55" : "#C16A4E") + '"/>'; }
        svg.innerHTML = s;
      }
      function drawSpark() {
        const H = 80, Wd = 200, ty = H - (Math.PI / 4) * H;
        let s = '<line x1="0" y1="' + ty.toFixed(1) + '" x2="' + Wd + '" y2="' + ty.toFixed(1) + '" stroke="#C98A2E" stroke-width="1.2" stroke-dasharray="4 3"/>';
        if (st.hist.length > 1) { const n = st.hist.length, pts = st.hist.map((v, i) => (i / (n - 1) * Wd).toFixed(1) + "," + (H - Math.min(1, v) * H).toFixed(1)).join(" "); s += '<polyline points="' + pts + '" fill="none" stroke="#5B7A5B" stroke-width="1.8"/>'; }
        ssvg.innerHTML = s;
      }
      function throwN(k) {
        for (let i = 0; i < k; i++) { const x = Math.random(), y = Math.random(), inside = (x * x + y * y) <= 1; st.n++; if (inside) st.inside++; if (st.pts.length < 2500) st.pts.push([x, y, inside]); st.hist.push(st.inside / st.n); }
        const ratio = st.inside / st.n;
        stat.innerHTML = "";
        stat.appendChild(el("div", "mc-line", "다트 " + st.n + "개 · 사분원 안 " + st.inside + "개"));
        const l2 = el("div", "mc-line"); l2.appendChild(document.createTextNode("넓이 비 ≈ ")); l2.appendChild(fracSpan(st.inside, st.n || 1)); l2.appendChild(document.createTextNode(" ≈ " + ratio.toFixed(3))); stat.appendChild(l2);
        stat.appendChild(el("div", "mc-line big", "π ≈ 4 × 넓이비 ≈ " + (4 * ratio).toFixed(3)));
        draw(); drawSpark();
        if (st.n >= need && !st.ran) { st.ran = true; qWrap.style.display = ""; }
      }
      draw(); drawSpark();
    },
    grade(ix, act) { const st = act._ix[ix.id]; return !!(st && st.ran && st.choice === ix.config.answer); }
  };

  /* place-target: 좌표평면에서 마커를 드래그해 목표점(여러 기준점에서 등거리인 점 등)을 찾는다.
     기준점까지의 거리를 실시간 표시. config: { x:[min,max], y:[min,max], anchors:[[x,y]], target:[x,y], tolerance?, snap?, anchorLabel?, markerLabel?, start? } */
  Kinds["place-target"] = {
    render(ix, host, act) {
      const cfg = ix.config, xr = cfg.x || [0, 8], yr = cfg.y || [0, 8];
      const anchors = cfg.anchors || [], snap = cfg.snap || 1;
      const aLab = cfg.anchorLabel || "신호";
      const st = (act._ix[ix.id] = { pt: (cfg.start ? cfg.start.slice() : [Math.round((xr[0] + xr[1]) / 2), Math.round((yr[0] + yr[1]) / 2)]) });
      const W = 360, H = 300, padL = 28, padB = 26;
      const X = (x) => padL + (x - xr[0]) / (xr[1] - xr[0]) * (W - padL - 10);
      const Y = (y) => (H - padB) - (y - yr[0]) / (yr[1] - yr[0]) * (H - padB - 10);
      const invX = (px) => xr[0] + (px - padL) / (W - padL - 10) * (xr[1] - xr[0]);
      const invY = (py) => yr[0] + ((H - padB) - py) / (H - padB - 10) * (yr[1] - yr[0]);
      const box = el("div", "ix-place"); box.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '"></svg>'; const svg = box.querySelector("svg");
      const read = el("div", "place-read");
      const dist = (a) => Math.sqrt((st.pt[0] - a[0]) * (st.pt[0] - a[0]) + (st.pt[1] - a[1]) * (st.pt[1] - a[1]));
      function redraw() {
        let s = "";
        for (let gx = Math.ceil(xr[0]); gx <= xr[1]; gx++) s += svgLine(X(gx), Y(yr[0]), X(gx), Y(yr[1]), "#EBF0E5", 1);
        for (let gy = Math.ceil(yr[0]); gy <= yr[1]; gy++) s += svgLine(X(xr[0]), Y(gy), X(xr[1]), Y(gy), "#EBF0E5", 1);
        if (yr[0] <= 0 && yr[1] >= 0) s += svgLine(X(xr[0]), Y(0), X(xr[1]), Y(0), "#9DB39A", 1.3);
        if (xr[0] <= 0 && xr[1] >= 0) s += svgLine(X(0), Y(yr[0]), X(0), Y(yr[1]), "#9DB39A", 1.3);
        anchors.forEach((a) => { s += '<line x1="' + X(st.pt[0]) + '" y1="' + Y(st.pt[1]) + '" x2="' + X(a[0]) + '" y2="' + Y(a[1]) + '" stroke="#C9A24A" stroke-width="1.4" stroke-dasharray="3 3"/>'; });
        anchors.forEach((a, i) => { s += '<circle cx="' + X(a[0]) + '" cy="' + Y(a[1]) + '" r="6.5" fill="#3F7FC4"/><text x="' + X(a[0]) + '" y="' + (Y(a[1]) - 10) + '" font-size="11" font-weight="700" text-anchor="middle" fill="#2C342C">' + aLab + (i + 1) + '</text>'; });
        s += '<circle cx="' + X(st.pt[0]) + '" cy="' + Y(st.pt[1]) + '" r="9" fill="#CC3F88" stroke="#fff" stroke-width="2.5"/>';
        svg.innerHTML = s;
        read.innerHTML = "";
        const ds = anchors.map(dist);
        anchors.forEach((a, i) => read.appendChild(el("span", "place-d", aLab + (i + 1) + " 거리 " + ds[i].toFixed(2))));
        const eq = ds.length && ds.every((d) => Math.abs(d - ds[0]) < 0.05);
        read.appendChild(el("span", "place-eq" + (eq ? " on" : ""), eq ? "✓ 세 거리가 같아요!" : "거리를 같게 만들어 보세요"));
      }
      function fromEvent(ev) {
        const r = svg.getBoundingClientRect(), p = ev.touches ? ev.touches[0] : ev;
        const vx = (p.clientX - r.left) / r.width * W, vy = (p.clientY - r.top) / r.height * H;
        let dx = Math.round(invX(vx) / snap) * snap, dy = Math.round(invY(vy) / snap) * snap;
        dx = Math.max(xr[0], Math.min(xr[1], dx)); dy = Math.max(yr[0], Math.min(yr[1], dy));
        st.pt = [dx, dy]; redraw();
      }
      let drag = false;
      svg.addEventListener("mousedown", (e) => { drag = true; fromEvent(e); });
      svg.addEventListener("mousemove", (e) => { if (drag) fromEvent(e); });
      window.addEventListener("mouseup", () => { drag = false; });
      svg.addEventListener("touchstart", (e) => { fromEvent(e); e.preventDefault(); }, { passive: false });
      svg.addEventListener("touchmove", (e) => { fromEvent(e); e.preventDefault(); }, { passive: false });
      box.appendChild(read); host.appendChild(box); redraw();
    },
    grade(ix, act) { const st = act._ix[ix.id], t = ix.config.target, tol = ix.config.tolerance || 0.5; return !!(st && t && Math.abs(st.pt[0] - t[0]) <= tol && Math.abs(st.pt[1] - t[1]) <= tol); }
  };

  /* dist-sim: 표본을 반복 추출해 히스토그램이 종 모양으로 모이는 과정을 직접 관찰한다.
     mode:"normal" → N(mu,sigma)에서 측정값 표본추출 / mode:"binomial" → B(n,p) 성공수 표본추출 + N(np,npq) 겹치기.
     config: { mode, mu, sigma, p, n, nList:[..], need, overlay } · grade: maxReached >= need (탐사 완수 게이트) */
  Kinds["dist-sim"] = {
    render(ix, host, act) {
      const cfg = ix.config || {}, mode = cfg.mode || "normal", need = cfg.need || 200, p = (cfg.p != null ? cfg.p : 0.5);
      const st = (act._ix[ix.id] = { total: 0, data: [], maxReached: 0, n: (cfg.nList ? cfg.nList[0] : (cfg.n || 20)) });
      const W = 340, H = 190, padL = 30, padB = 22;
      const wrap = el("div", "ix-dsim");
      const stage = el("div", "dsim-stage"); stage.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '"></svg>'; const svg = stage.querySelector("svg");
      const stat = el("div", "dsim-stat");
      wrap.appendChild(stage); wrap.appendChild(stat);
      function gauss(mu, sig) { let u = 0, v = 0; while (u === 0) u = Math.random(); while (v === 0) v = Math.random(); return mu + sig * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
      function sampleOne() { if (mode === "binomial") { let c = 0; for (let k = 0; k < st.n; k++) if (Math.random() < p) c++; return c; } return gauss(cfg.mu || 0, cfg.sigma || 1); }
      function binning() {
        let lo, hi, nb, binW;
        if (mode === "binomial") { lo = -0.5; hi = st.n + 0.5; nb = st.n + 1; binW = 1; }
        else { const mu = cfg.mu || 0, sg = cfg.sigma || 1; lo = mu - 4 * sg; hi = mu + 4 * sg; nb = 24; binW = (hi - lo) / nb; }
        const counts = new Array(nb).fill(0);
        st.data.forEach((x) => { let bi = Math.floor((x - lo) / binW); if (bi < 0) bi = 0; if (bi >= nb) bi = nb - 1; counts[bi]++; });
        return { lo, hi, nb, binW, counts };
      }
      function redraw() {
        const b = binning(), maxc = Math.max(1, ...b.counts);
        const X = (x) => padL + (x - b.lo) / (b.hi - b.lo) * (W - padL - 8);
        const Y = (c) => (H - padB) - c / (maxc * 1.12) * (H - padB - 8);
        let s = svgLine(padL, Y(0), W - 4, Y(0), "#9DB39A", 1.2);
        for (let i = 0; i < b.nb; i++) {
          if (!b.counts[i]) continue;
          const x0 = X(b.lo + i * b.binW), x1 = X(b.lo + (i + 1) * b.binW), w = Math.max(1, x1 - x0 - 1);
          s += '<rect x="' + (x0 + 0.5).toFixed(1) + '" y="' + Y(b.counts[i]).toFixed(1) + '" width="' + w.toFixed(1) + '" height="' + Math.max(0, (H - padB) - Y(b.counts[i])).toFixed(1) + '" fill="#7CA0C9" rx="1"/>';
        }
        if (cfg.overlay !== false && st.total > 0) {
          let mu, sg;
          if (mode === "binomial") { mu = st.n * p; sg = Math.sqrt(st.n * p * (1 - p)) || 0.5; }
          else { mu = cfg.mu || 0; sg = cfg.sigma || 1; }
          const pts = [];
          for (let k = 0; k <= 80; k++) { const x = b.lo + (b.hi - b.lo) * k / 80; const dens = 1 / (sg * Math.sqrt(2 * Math.PI)) * Math.exp(-((x - mu) * (x - mu)) / (2 * sg * sg)); pts.push(X(x).toFixed(1) + "," + Y(dens * st.total * b.binW).toFixed(1)); }
          s += '<polyline points="' + pts.join(" ") + '" fill="none" stroke="#C9772E" stroke-width="2.2"/>';
        }
        svg.innerHTML = s;
        stat.innerHTML = "";
        stat.appendChild(el("span", "dsim-pill" + (st.maxReached >= need ? " ok" : ""), "표본 " + st.total + (st.maxReached >= need ? " ✓" : " / " + need)));
        if (mode === "binomial") { stat.appendChild(el("span", "dsim-pill", "n = " + st.n)); stat.appendChild(el("span", "dsim-pill", "np = " + (st.n * p).toFixed(1))); stat.appendChild(el("span", "dsim-pill", "npq = " + (st.n * p * (1 - p)).toFixed(2))); }
        else if (st.total > 0) { const m = st.data.reduce((a, c) => a + c, 0) / st.total, v = st.data.reduce((a, c) => a + (c - m) * (c - m), 0) / st.total; stat.appendChild(el("span", "dsim-pill", "표본평균 ≈ " + m.toFixed(2))); stat.appendChild(el("span", "dsim-pill", "표본표준편차 ≈ " + Math.sqrt(v).toFixed(2))); }
      }
      function add(k) { for (let i = 0; i < k; i++) st.data.push(sampleOne()); st.total += k; st.maxReached = Math.max(st.maxReached, st.total); redraw(); }
      const btns = el("div", "dsim-btns");
      if (mode === "binomial" && cfg.nList) cfg.nList.forEach((nv) => { const bn = el("button", "dsim-nbtn" + (nv === st.n ? " on" : ""), "n=" + nv); bn.type = "button"; bn.onclick = () => { st.n = nv; st.data = []; st.total = 0; [...btns.querySelectorAll(".dsim-nbtn")].forEach((e) => e.classList.toggle("on", e.textContent === "n=" + nv)); redraw(); }; btns.appendChild(bn); });
      [["+10", 10], ["+100", 100], ["+1000", 1000]].forEach((kv) => { const bb = el("button", "ix-sim-roll" + (kv[1] > 10 ? " alt" : ""), "표본 " + kv[0]); bb.type = "button"; bb.onclick = () => add(kv[1]); btns.appendChild(bb); });
      wrap.appendChild(btns); host.appendChild(wrap); redraw();
    },
    grade(ix, act) { const st = act._ix[ix.id]; const need = (ix.config && ix.config.need) || 200; return !!(st && st.maxReached >= need); }
  };

  function gaussSample(mu, sig) { let u = 0, v = 0; while (u === 0) u = Math.random(); while (v === 0) v = Math.random(); return mu + sig * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

  /* pond: 물고기(또는 유전자 동전)를 직접 클릭/그물로 '잡아' 표본을 만들고 히스토그램을 쌓는다.
     mode:"normal"(N(mu,sigma) 몸길이) / "binomial"(B(n,p) 켜진 수, nList로 n↑). grade: maxReached>=need. */
  Kinds["pond"] = {
    render(ix, host, act) {
      const cfg = ix.config || {}, mode = cfg.mode || "normal", need = cfg.need || 40, p = (cfg.p != null ? cfg.p : 0.5);
      const st = (act._ix[ix.id] = { caught: 0, data: [], maxReached: 0, n: (cfg.nList ? cfg.nList[0] : (cfg.n || 20)) });
      const PW = 340, PH = 110, HW = 340, HH = 120;
      const wrap = el("div", "ix-pond");
      const pond = el("div", "pond-water"); pond.innerHTML = '<svg viewBox="0 0 ' + PW + ' ' + PH + '"></svg>'; const psvg = pond.querySelector("svg");
      const stat = el("div", "dsim-stat");
      const hist = el("div", "pond-hist"); hist.innerHTML = '<svg viewBox="0 0 ' + HW + ' ' + HH + '"></svg>'; const hsvg = hist.querySelector("svg");
      const col = mode === "binomial" ? "#C9A24A" : "#5B86B0";
      function sampleOne() { if (mode === "binomial") { let c = 0; for (let k = 0; k < st.n; k++) if (Math.random() < p) c++; return c; } return gaussSample(cfg.mu || 0, cfg.sigma || 1); }
      function drawHist() {
        let lo, hi, nb, bw;
        if (mode === "binomial") { lo = -0.5; hi = st.n + 0.5; nb = st.n + 1; bw = 1; } else { const mu = cfg.mu || 0, sg = cfg.sigma || 1; lo = mu - 4 * sg; hi = mu + 4 * sg; nb = 22; bw = (hi - lo) / nb; }
        const counts = new Array(nb).fill(0); st.data.forEach((x) => { let b = Math.floor((x - lo) / bw); if (b < 0) b = 0; if (b >= nb) b = nb - 1; counts[b]++; });
        const maxc = Math.max(1, ...counts), padB = 16;
        const X = (x) => 4 + (x - lo) / (hi - lo) * (HW - 8), Y = (c) => (HH - padB) - c / (maxc * 1.12) * (HH - padB - 6);
        let s = svgLine(4, Y(0), HW - 4, Y(0), "#9DB39A", 1.2);
        for (let i = 0; i < nb; i++) { if (!counts[i]) continue; const x0 = X(lo + i * bw), x1 = X(lo + (i + 1) * bw); s += '<rect x="' + (x0 + 0.5).toFixed(1) + '" y="' + Y(counts[i]).toFixed(1) + '" width="' + Math.max(1, x1 - x0 - 1).toFixed(1) + '" height="' + Math.max(0, (HH - padB) - Y(counts[i])).toFixed(1) + '" rx="1" fill="' + col + '"/>'; }
        if (cfg.overlay !== false && st.caught > 0) { let mu, sg; if (mode === "binomial") { mu = st.n * p; sg = Math.sqrt(st.n * p * (1 - p)) || 0.5; } else { mu = cfg.mu || 0; sg = cfg.sigma || 1; } const pts = []; for (let k = 0; k <= 80; k++) { const x = lo + (hi - lo) * k / 80; const d = 1 / (sg * Math.sqrt(2 * Math.PI)) * Math.exp(-((x - mu) * (x - mu)) / (2 * sg * sg)); pts.push(X(x).toFixed(1) + "," + Y(d * st.caught * bw).toFixed(1)); } s += '<polyline points="' + pts.join(" ") + '" fill="none" stroke="#C9772E" stroke-width="2"/>'; }
        hsvg.innerHTML = s;
      }
      function updateStat() {
        stat.innerHTML = "";
        stat.appendChild(el("span", "dsim-pill" + (st.maxReached >= need ? " ok" : ""), "잡은 수 " + st.caught + (st.maxReached >= need ? " ✓" : " / " + need)));
        if (mode === "binomial") { stat.appendChild(el("span", "dsim-pill", "n = " + st.n)); stat.appendChild(el("span", "dsim-pill", "np = " + (st.n * p).toFixed(1))); stat.appendChild(el("span", "dsim-pill", "npq = " + (st.n * p * (1 - p)).toFixed(2))); }
        else if (st.caught > 0) { const m = st.data.reduce((a, c) => a + c, 0) / st.caught, v = st.data.reduce((a, c) => a + (c - m) * (c - m), 0) / st.caught; stat.appendChild(el("span", "dsim-pill", "평균 ≈ " + m.toFixed(1))); stat.appendChild(el("span", "dsim-pill", "표준편차 ≈ " + Math.sqrt(v).toFixed(1))); }
      }
      function spawnFish() {
        let s = '<rect x="0" y="0" width="' + PW + '" height="' + PH + '" rx="10" fill="#E7F0F5"/>';
        for (let i = 0; i < 9; i++) {
          const x = (14 + Math.random() * (PW - 34)).toFixed(0), y = (14 + Math.random() * (PH - 28)).toFixed(0), fl = Math.random() < 0.5 ? -1 : 1, dur = (2.4 + Math.random() * 2).toFixed(1), del = (Math.random() * 1.5).toFixed(1);
          s += '<g class="pf" transform="translate(' + x + ',' + y + ')"><g class="pf-b" style="animation:bob ' + dur + 's ease-in-out ' + del + 's infinite alternate" transform="scale(' + fl + ',1)">' +
            (mode === "binomial"
              ? '<circle r="8" fill="' + col + '"/><text x="0" y="3.5" font-size="9" text-anchor="middle" fill="#fff" font-weight="800">⚙</text>'
              : '<ellipse rx="9" ry="5" fill="' + col + '"/><polygon points="8,0 14,-5 14,5" fill="' + col + '"/><circle cx="-4" cy="-1" r="1.4" fill="#fff"/>') +
            '</g></g>';
        }
        psvg.innerHTML = s;
        [...psvg.querySelectorAll(".pf")].forEach((g) => { g.style.cursor = "pointer"; g.onclick = () => { catchN(1); }; });
      }
      function catchN(k) { for (let i = 0; i < k; i++) st.data.push(sampleOne()); st.caught += k; st.maxReached = Math.max(st.maxReached, st.caught); drawHist(); updateStat(); spawnFish(); }
      const btns = el("div", "dsim-btns");
      if (mode === "binomial" && cfg.nList) cfg.nList.forEach((nv) => { const bn = el("button", "dsim-nbtn" + (nv === st.n ? " on" : ""), "n=" + nv); bn.type = "button"; bn.onclick = () => { st.n = nv; st.data = []; st.caught = 0; [...btns.querySelectorAll(".dsim-nbtn")].forEach((e) => e.classList.toggle("on", e.textContent === "n=" + nv)); drawHist(); updateStat(); }; btns.appendChild(bn); });
      const net = el("button", "ix-sim-roll alt", mode === "binomial" ? "⚙ 한 번에 +20" : "🎣 그물 던지기 (+20)"); net.type = "button"; net.onclick = () => catchN(20); btns.appendChild(net);
      wrap.appendChild(el("div", "pond-hint", mode === "binomial" ? "동전(유전자)을 클릭하거나 한 번에 여러 번 던져 '켜진 수'를 쌓으세요" : "물고기를 클릭해 한 마리씩, 또는 그물로 한 번에 잡으세요"));
      wrap.appendChild(pond); wrap.appendChild(stat); wrap.appendChild(hist); wrap.appendChild(btns);
      host.appendChild(wrap); spawnFish(); drawHist(); updateStat();
    },
    grade(ix, act) { const st = act._ix[ix.id]; const need = (ix.config && ix.config.need) || 40; return !!(st && st.maxReached >= need); }
  };

  /* stat-marker: 정규분포 히스토그램 위에 '평균선'과 'σ 폭'을 직접 끌어다 표시한다(고르기 아님, 조작으로 증명).
     config: { mu, sigma, range:[lo,hi], tolMu, tolSig }. grade: 평균·표준편차 모두 허용오차 이내. */
  Kinds["stat-marker"] = {
    render(ix, host, act) {
      const cfg = ix.config || {}, mu = cfg.mu || 0, sg = cfg.sigma || 1;
      const lo = (cfg.range && cfg.range[0] != null) ? cfg.range[0] : mu - 4 * sg, hi = (cfg.range && cfg.range[1] != null) ? cfg.range[1] : mu + 4 * sg;
      const st = (act._ix[ix.id] = { mu: lo + (hi - lo) * 0.32, sigma: (hi - lo) * 0.08 });
      const W = 340, H = 200, padB = 24;
      const wrap = el("div", "ix-statmark");
      const box = el("div", "sm-stage"); box.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" style="touch-action:none"></svg>'; const svg = box.querySelector("svg");
      const read = el("div", "dsim-stat");
      const X = (x) => 8 + (x - lo) / (hi - lo) * (W - 16), invX = (px) => lo + (px - 8) / (W - 16) * (hi - lo);
      const nb = 30, bw = (hi - lo) / nb;
      function pdf(x) { return Math.exp(-((x - mu) * (x - mu)) / (2 * sg * sg)); }
      const heights = []; let mx = 0; for (let i = 0; i < nb; i++) { const c = (lo + (i + 0.5) * bw); const v = pdf(c); heights.push(v); if (v > mx) mx = v; }
      function draw() {
        const Yb = H - padB; const top = 14;
        let s = svgLine(8, Yb, W - 8, Yb, "#9DB39A", 1.2);
        for (let i = 0; i < nb; i++) { const x0 = X(lo + i * bw), x1 = X(lo + (i + 1) * bw), hgt = heights[i] / (mx * 1.08) * (Yb - top); s += '<rect x="' + (x0 + 0.5).toFixed(1) + '" y="' + (Yb - hgt).toFixed(1) + '" width="' + Math.max(1, x1 - x0 - 1).toFixed(1) + '" height="' + hgt.toFixed(1) + '" rx="1" fill="#BFD0E2"/>'; }
        const mX = X(st.mu), sR = X(st.mu + st.sigma), sL = X(st.mu - st.sigma);
        s += '<rect x="' + Math.min(sL, sR).toFixed(1) + '" y="' + top + '" width="' + Math.abs(sR - sL).toFixed(1) + '" height="' + (Yb - top) + '" fill="#5B7A5B" opacity="0.12"/>';
        s += svgLine(mX, top - 4, mX, Yb, "#3F7FC4", 2.2);
        s += '<circle cx="' + mX.toFixed(1) + '" cy="' + (top - 4) + '" r="7" fill="#3F7FC4"/><text x="' + mX.toFixed(1) + '" y="' + (top - 1) + '" font-size="8" text-anchor="middle" fill="#fff" font-weight="800">μ</text>';
        [sR, sL].forEach((hx, idx) => { s += svgLine(hx, top + 8, hx, Yb, "#5B7A5B", 1.6, true); s += '<circle cx="' + hx.toFixed(1) + '" cy="' + (Yb - 10) + '" r="6.5" fill="#5B7A5B"/><text x="' + hx.toFixed(1) + '" y="' + (Yb - 7) + '" font-size="7.5" text-anchor="middle" fill="#fff" font-weight="800">σ</text>'; });
        svg.innerHTML = s;
        read.innerHTML = ""; read.appendChild(el("span", "dsim-pill", "평균 μ ≈ " + st.mu.toFixed(1))); read.appendChild(el("span", "dsim-pill", "표준편차 σ ≈ " + st.sigma.toFixed(1)));
      }
      let mode = null;
      function pick(px) { const mX = X(st.mu), sR = X(st.mu + st.sigma), sL = X(st.mu - st.sigma); const dm = Math.abs(px - mX), ds = Math.min(Math.abs(px - sR), Math.abs(px - sL)); mode = (dm <= ds) ? "mu" : "sig"; }
      function move(px) { const x = invX(px); if (mode === "mu") { st.mu = Math.max(lo, Math.min(hi, x)); } else { st.sigma = Math.max((hi - lo) * 0.02, Math.abs(x - st.mu)); } draw(); }
      function evX(e) { const r = svg.getBoundingClientRect(), c = e.touches ? e.touches[0] : e; return (c.clientX - r.left) / r.width * W; }
      svg.addEventListener("mousedown", (e) => { pick(evX(e)); move(evX(e)); });
      svg.addEventListener("mousemove", (e) => { if (mode) move(evX(e)); });
      window.addEventListener("mouseup", () => { mode = null; });
      svg.addEventListener("touchstart", (e) => { pick(evX(e)); move(evX(e)); e.preventDefault(); }, { passive: false });
      svg.addEventListener("touchmove", (e) => { if (mode) move(evX(e)); e.preventDefault(); }, { passive: false });
      wrap.appendChild(box); wrap.appendChild(read); host.appendChild(wrap); draw();
    },
    grade(ix, act) { const st = act._ix[ix.id], cfg = ix.config || {}, mu = cfg.mu || 0, sg = cfg.sigma || 1; const lo = (cfg.range && cfg.range[0] != null) ? cfg.range[0] : mu - 4 * sg, hi = (cfg.range && cfg.range[1] != null) ? cfg.range[1] : mu + 4 * sg; const tM = cfg.tolMu != null ? cfg.tolMu : (hi - lo) * 0.05, tS = cfg.tolSig != null ? cfg.tolSig : sg * 0.3; return !!(st && Math.abs(st.mu - mu) <= tM && Math.abs(st.sigma - sg) <= tS); }
  };

  /* z-place: 값(물고기)을 표준화한 위치로 Z 눈금자에 직접 끌어다 놓는다. 표준화를 '직접 수행'·비교.
     config: { fishes:[{label, mu, sigma, x, color?}], tol }. grade: 모든 fish의 놓인 Z가 (x-mu)/sigma 와 tol 이내. */
  Kinds["z-place"] = {
    render(ix, host, act) {
      const cfg = ix.config || {}, fishes = cfg.fishes || [], zr = cfg.zrange || [-3.2, 3.2], tol = cfg.tol != null ? cfg.tol : 0.25;
      const st = (act._ix[ix.id] = { pos: fishes.map(() => zr[0] + 0.4) });   // 처음엔 왼쪽 끝
      const W = 340, H = 70 + fishes.length * 26, ry = H - 26;
      const wrap = el("div", "ix-zplace");
      const box = el("div", "zp-stage"); box.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" style="touch-action:none"></svg>'; const svg = box.querySelector("svg");
      const read = el("div", "dsim-stat");
      const X = (z) => 16 + (z - zr[0]) / (zr[1] - zr[0]) * (W - 32), invX = (px) => zr[0] + (px - 16) / (W - 32) * (zr[1] - zr[0]);
      const cols = ["#CC3F88", "#3F7FC4", "#C9772E"];
      function draw() {
        let s = svgLine(16, ry, W - 16, ry, "#9DB39A", 1.6);
        for (let z = Math.ceil(zr[0]); z <= zr[1]; z++) { s += svgLine(X(z), ry - 4, X(z), ry + 4, z === 0 ? "#5B7A5B" : "#C2CDB8", z === 0 ? 2 : 1); s += '<text x="' + X(z).toFixed(1) + '" y="' + (ry + 16) + '" font-size="9" text-anchor="middle" fill="#7A8A78">' + z + '</text>'; }
        s += '<text x="' + X(0).toFixed(1) + '" y="' + (ry - 9) + '" font-size="9" text-anchor="middle" fill="#5B7A5B" font-weight="800">평균(Z=0)</text>';
        fishes.forEach((f, i) => { const cx = X(st.pos[i]), c = f.color || cols[i % cols.length]; s += svgLine(cx, 14 + i * 22, cx, ry, c, 1, true); s += '<g class="zp-tok" data-i="' + i + '" style="cursor:grab"><rect x="' + (cx - 56).toFixed(1) + '" y="' + (4 + i * 22) + '" width="112" height="18" rx="9" fill="' + c + '"/><text x="' + cx.toFixed(1) + '" y="' + (16 + i * 22) + '" font-size="9.5" text-anchor="middle" fill="#fff" font-weight="700">' + f.label + '</text></g>'; });
        svg.innerHTML = s;
        read.innerHTML = ""; fishes.forEach((f, i) => read.appendChild(el("span", "dsim-pill", f.label.split(" ")[0] + " Z ≈ " + st.pos[i].toFixed(2))));
      }
      let drag = -1;
      function evX(e) { const r = svg.getBoundingClientRect(), c = e.touches ? e.touches[0] : e; return (c.clientX - r.left) / r.width * W; }
      function pickIdx(px, py) { let best = -1, bd = 1e9; fishes.forEach((f, i) => { const d = Math.abs(px - X(st.pos[i])); if (d < bd) { bd = d; best = i; } }); return bd < 80 ? best : -1; }
      svg.addEventListener("mousedown", (e) => { drag = pickIdx(evX(e)); if (drag >= 0) { st.pos[drag] = Math.max(zr[0], Math.min(zr[1], invX(evX(e)))); draw(); } });
      svg.addEventListener("mousemove", (e) => { if (drag >= 0) { st.pos[drag] = Math.max(zr[0], Math.min(zr[1], invX(evX(e)))); draw(); } });
      window.addEventListener("mouseup", () => { drag = -1; });
      svg.addEventListener("touchstart", (e) => { drag = pickIdx(evX(e)); if (drag >= 0) { st.pos[drag] = Math.max(zr[0], Math.min(zr[1], invX(evX(e)))); draw(); } e.preventDefault(); }, { passive: false });
      svg.addEventListener("touchmove", (e) => { if (drag >= 0) { st.pos[drag] = Math.max(zr[0], Math.min(zr[1], invX(evX(e)))); draw(); } e.preventDefault(); }, { passive: false });
      wrap.appendChild(box); wrap.appendChild(read); host.appendChild(wrap); draw();
    },
    grade(ix, act) { const st = act._ix[ix.id], cfg = ix.config || {}, fishes = cfg.fishes || [], tol = cfg.tol != null ? cfg.tol : 0.25; return !!(st && fishes.every((f, i) => Math.abs(st.pos[i] - (f.x - f.mu) / f.sigma) <= tol)); }
  };

  window.SAGE = window.SAGE || {};
  window.SAGE.Templates = Templates;
  window.SAGE.InteractionKinds = Kinds;   // 관리자 페이지에서 조작 유형 목록 참조용
})();
