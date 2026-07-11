#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
data/ 콘텐츠 무결성 검증기 (역할 B 소유, B-3).

manifest.json을 단일 출처로 nodes/edges/activities를 로드해 다음을 검사한다.

[ERROR] (0건 유지 — 지시서 B-3 핵심 4종 + 파싱)
  E1. JSON 파싱 오류
  E2. 노드 id 중복 (파일 간 포함)
  E3. 끊긴 간선        : edge.from/to 가 존재하지 않는 노드
  E4. 자기참조 간선     : from == to
  E5. 중복 간선        : 동일 (from,to,rel) 반복
  E6. 순환(cycle)      : prerequisite 그래프의 사이클
  E7. 누락 skill       : activity.step.skillId 가 해당 성취기준 skills 에 없음
                         (또는 activity.standardId 가 존재하지 않는 성취기준)

[WARN] (권고 — 차단하지 않음)
  W1. parent 끊김       : node.parent 가 존재하지 않는 노드
  W2. skill id 규칙     : skills[].id 가 '<성취기준코드>-<영문자>' 형식이 아님 (-a/-b 규칙)
  W3. skill id 중복     : 같은 성취기준 안에서 skill id 중복
  W4. 고아 활동         : activity.standardId 의 성취기준이 skills 가 비어 채점 불가
  W5. 고립 성취기준      : 선수·후속 간선이 모두 없는 성취기준 (계통도 견고성)
  W6. 학년/단계 역행 간선 : 선수(from) 단계가 의존(to) 단계보다 뒤 (예: 미적Ⅱ→공통)

종료코드: ERROR 1건 이상이면 1, 아니면 0.
실행:  python3 validate.py   (프로젝트 루트에서)
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
MANIFEST = os.path.join(ROOT, "data", "manifest.json")

errors = []   # (코드, 메시지)
warns = []

SKILL_ID_RE = re.compile(r"^.+-[a-z]$")  # <코드>-a / -b ... (소문자 1자 접미)


def load_json(rel_path):
    path = os.path.join(ROOT, rel_path)
    if not os.path.exists(path):
        errors.append(("E1", f"파일 없음: {rel_path}"))
        return None
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except json.JSONDecodeError as e:
        errors.append(("E1", f"JSON 파싱 오류: {rel_path} → {e}"))
        return None


def main():
    manifest = load_json(os.path.relpath(MANIFEST, ROOT))
    if manifest is None:
        report()
        return

    # ---- 노드 로드 + id 중복(E2) ----
    node_by_id = {}          # id -> node
    node_origin = {}         # id -> 파일(첫 등장)
    for rel in manifest.get("nodes", []):
        data = load_json(rel)
        if not data:
            continue
        for n in data.get("nodes", []):
            nid = n.get("id")
            if nid is None:
                errors.append(("E2", f"{rel}: id 없는 노드 {n}"))
                continue
            if nid in node_by_id:
                errors.append(("E2", f"노드 id 중복: '{nid}' ({node_origin[nid]} ↔ {rel})"))
                continue
            node_by_id[nid] = n
            node_origin[nid] = rel

    # ---- parent 끊김(W1) ----
    for nid, n in node_by_id.items():
        parent = n.get("parent")
        if parent is not None and parent not in node_by_id:
            warns.append(("W1", f"parent 끊김: '{nid}' → 없는 노드 '{parent}'"))

    # ---- skills 인덱스 + 규칙(W2) + 중복(W3) ----
    # standardId -> set(skillId)
    skills_by_std = {}
    for nid, n in node_by_id.items():
        skills = n.get("skills")
        if not skills:
            continue
        seen = set()
        ids = set()
        for s in skills:
            sid = s.get("id")
            if sid is None:
                warns.append(("W2", f"{nid}: id 없는 skill {s}"))
                continue
            if sid in seen:
                warns.append(("W3", f"{nid}: skill id 중복 '{sid}'"))
            seen.add(sid)
            ids.add(sid)
            if not SKILL_ID_RE.match(sid):
                warns.append(("W2", f"{nid}: skill id 규칙 위반 '{sid}' (기대: <코드>-a/-b)"))
            elif not sid.startswith(str(n.get("code", nid))):
                warns.append(("W2", f"{nid}: skill id 접두 불일치 '{sid}'"))
        skills_by_std[nid] = ids

    # ---- 간선 로드: 끊김(E3)/자기참조(E4)/중복(E5) ----
    prereq_adj = {}          # from -> [to,...]  (순환 검사용)
    seen_edges = {}          # (from,to,rel) -> 파일
    for rel in manifest.get("edges", []):
        data = load_json(rel)
        if not data:
            continue
        for e in data.get("edges", []):
            fr, to, kind = e.get("from"), e.get("to"), e.get("rel")
            key = (fr, to, kind)
            if fr not in node_by_id:
                errors.append(("E3", f"{rel}: 끊긴 간선 from '{fr}' (없는 노드) → '{to}'"))
            if to not in node_by_id:
                errors.append(("E3", f"{rel}: 끊긴 간선 to '{to}' (없는 노드) ← '{fr}'"))
            if fr == to:
                errors.append(("E4", f"{rel}: 자기참조 간선 '{fr}' ({kind})"))
            if key in seen_edges:
                errors.append(("E5", f"중복 간선 {key} ({seen_edges[key]} ↔ {rel})"))
            else:
                seen_edges[key] = rel
            if kind == "prerequisite" and fr in node_by_id and to in node_by_id:
                prereq_adj.setdefault(fr, []).append(to)

    # ---- 순환 검사(E6): prerequisite DFS ----
    WHITE, GRAY, BLACK = 0, 1, 2
    color = {}
    stack = []

    def dfs(u):
        color[u] = GRAY
        stack.append(u)
        for v in prereq_adj.get(u, []):
            if color.get(v, WHITE) == GRAY:
                i = stack.index(v)
                cycle = stack[i:] + [v]
                errors.append(("E6", "순환(prerequisite): " + " → ".join(cycle)))
            elif color.get(v, WHITE) == WHITE:
                dfs(v)
        stack.pop()
        color[u] = BLACK

    for u in list(prereq_adj.keys()):
        if color.get(u, WHITE) == WHITE:
            dfs(u)

    # ---- 계통도 견고성 감사 (W5 고립 / W6 학년 역행) ----
    TIER = {"9수": 0, "10공수1": 1, "10공수2": 1, "12대수": 2, "12미적Ⅰ": 2,
            "12미적Ⅱ": 3, "12기하": 2, "12확통": 2, "확통": 2}
    def tier_of(sid):
        for p in sorted(TIER, key=len, reverse=True):
            if sid.startswith(p):
                return TIER[p]
        return None
    stds = [nid for nid, n in node_by_id.items() if n.get("type") == "standard"]
    indeg = {s: 0 for s in stds}
    outdeg = {s: 0 for s in stds}
    for fr, tos in prereq_adj.items():
        for to in tos:
            if fr in outdeg:
                outdeg[fr] += 1
            if to in indeg:
                indeg[to] += 1
    for s in stds:
        if indeg.get(s, 0) == 0 and outdeg.get(s, 0) == 0:
            warns.append(("W5", f"고립 성취기준(선수·후속 모두 없음): {s}"))
    for fr, tos in prereq_adj.items():
        tf = tier_of(fr)
        for to in tos:
            tt = tier_of(to)
            if tf is not None and tt is not None and tf > tt:
                warns.append(("W6", f"학년/단계 역행 간선: {fr}(tier{tf}) → {to}(tier{tt})"))

    # ---- 수행능력 선수관계(skillPrereq) 검사(E9): 끊긴 skill id / 자기참조 ----
    all_skill_ids = set()
    for ids in skills_by_std.values():
        all_skill_ids |= ids
    for rel in manifest.get("skillPrereq", []):
        data = load_json(rel)
        if not data:
            continue
        for e in data.get("edges", []):
            fr, to = e.get("from"), e.get("to")
            if fr not in all_skill_ids:
                errors.append(("E9", f"{rel}: skillPrereq from '{fr}' — 존재하지 않는 수행능력"))
            if to not in all_skill_ids:
                errors.append(("E9", f"{rel}: skillPrereq to '{to}' — 존재하지 않는 수행능력"))
            if fr == to:
                errors.append(("E9", f"{rel}: skillPrereq 자기참조 '{fr}'"))

    # ---- 활동 검사(E7 확장: steps + interactions)/고아(W4)/조작 config 구조(E8) ----
    VALID_TPL = {"stepwise", "interactive"}

    def ft_pos(k):
        m = re.search(r"(\d+)\s*-\s*(\d+)", re.sub(r"^r", "", str(k), flags=re.I))
        return f"{m.group(1)}-{m.group(2)}" if m else None

    def check_config(rel, aid, iid, kind, cfg):
        """조작 부품 config가 실제 채점 계약(templates.js grade)과 맞는지 — 어긋나면 런타임에야 드러나므로 ERROR."""
        E = lambda msg: errors.append(("E8", f"{rel}: {aid}/{iid} [{kind}] {msg}"))
        if kind == "build-set":
            vals = {str(it.get("val")) for it in cfg.get("items", [])}
            tg = [str(t) for t in cfg.get("target", [])]
            if not tg:
                E("target 비어있음")
            for t in tg:
                if t not in vals:
                    E(f"target '{t}' 가 items 에 없음")
        elif kind == "order-seq":
            vals = [str(it.get("val")) for it in cfg.get("items", [])]
            order = [str(o) for o in cfg.get("order", [])]
            if set(order) != set(vals) or len(order) != len(vals):
                E("order 가 items 의 순열이 아님")
        elif kind == "drag-match":
            for i, p in enumerate(cfg.get("pairs", [])):
                if not p.get("left") or not p.get("right"):
                    E(f"pairs[{i}] left/right 누락")
        elif kind == "compute":
            if cfg.get("accept") is None:
                ans = str(cfg.get("answer", "")).strip().replace("−", "-")
                if not re.fullmatch(r"-?\d+(\.\d+)?(/-?\d+(\.\d+)?)?", ans):
                    E(f"answer 비수치 '{cfg.get('answer')}' (accept 없이)")
        elif kind == "expr":
            if not str(cfg.get("answer", "")).strip():
                E("answer 비어있음")
            for bad in ["∫", "∑", "√", "sin", "cos", "tan", "log", "ln", "π"]:
                if bad in str(cfg.get("answer", "")):
                    E(f"answer 에 채점 불가 기호 '{bad}'")
        elif kind == "slider":
            if not cfg.get("preview"):
                warns.append(("W7", f"{rel}: {aid}/{iid} [slider] preview 없음(그래프 미표시)"))
            for s in cfg.get("sliders", []):
                t, mn, mx = s.get("target"), s.get("min"), s.get("max")
                step, init = s.get("step", 1), s.get("init", s.get("min"))
                if t is None:
                    E(f"slider '{s.get('key')}' target 없음"); continue
                if not (mn <= t <= mx):
                    E(f"slider '{s.get('key')}' target {t} ∉ [{mn},{mx}]")
                if step and abs(((t - init) / step) - round((t - init) / step)) > 1e-6:
                    E(f"slider '{s.get('key')}' target {t} 이 step {step} 격자에 없음(init {init})")
                if init == t:
                    E(f"slider '{s.get('key')}' init == target (무조작 통과·정답 노출)")
        elif kind in ("grid-plot", "place-target"):
            xr, yr = cfg.get("x", [0, 8]), cfg.get("y", [0, 8])
            tgs = cfg.get("target", []) if kind == "grid-plot" else ([cfg.get("target")] if cfg.get("target") else [])
            for p in tgs:
                if not p:
                    continue
                if not (xr[0] <= p[0] <= xr[1] and yr[0] <= p[1] <= yr[1]):
                    E(f"target {p} 좌표 범위 밖 x{xr} y{yr}")
                if kind == "grid-plot" and (p[0] != int(p[0]) or p[1] != int(p[1])):
                    E(f"target {p} 정수 격자점 아님")
            if kind == "place-target":
                for an in cfg.get("anchors", []):
                    if not (xr[0] <= an[0] <= xr[1] and yr[0] <= an[1] <= yr[1]):
                        E(f"anchor {an} 좌표 범위 밖")
                t = cfg.get("target"); tol = cfg.get("tolerance", 0.5)
                start = cfg.get("start") or [round((xr[0] + xr[1]) / 2), round((yr[0] + yr[1]) / 2)]
                if t and abs(start[0] - t[0]) <= tol and abs(start[1] - t[1]) <= tol:
                    E(f"시작 위치 {start} 가 target {t} 허용오차 안(정답 노출)")
        elif kind == "stat-marker":
            mu, sg = cfg.get("mu"), cfg.get("sigma")
            rng = cfg.get("range") or [(mu or 0) - 4 * (sg or 1), (mu or 0) + 4 * (sg or 1)]
            lo, hi = rng[0], rng[1]
            mu0, sg0 = lo + (hi - lo) * 0.32, (hi - lo) * 0.08   # templates.js 초기값과 동일식
            tM = cfg.get("tolMu", (hi - lo) * 0.05)
            tS = cfg.get("tolSig", (sg or 1) * 0.3)
            if mu is not None and abs(mu0 - mu) <= tM and abs(sg0 - sg) <= tS:
                E(f"초기 위치(μ0={mu0:.2f}, σ0={sg0:.2f})가 허용오차 안 — 무조작 통과")
        elif kind == "fill-table":
            rows, blanks = cfg.get("rows", []), cfg.get("blanks", [])
            answers = cfg.get("answers", {})
            cellvals = {str(c) for row in rows for c in row}
            pos2key = {}
            for b in blanks:
                if b in cellvals:
                    continue
                p = ft_pos(b)
                if p:
                    pos2key[p] = b
            rendered = set()
            for r, row in enumerate(rows):
                for c, cell in enumerate(row):
                    if str(cell) in blanks:
                        rendered.add(str(cell))
                    elif pos2key.get(f"{r}-{c}"):
                        rendered.add(pos2key[f"{r}-{c}"])
            for ak in answers:
                if ak not in rendered:
                    E(f"answers 키 '{ak}' 에 해당하는 입력칸이 표에 없음")
            for rk in rendered:
                if rk not in answers:
                    E(f"입력칸 '{rk}' 의 정답이 answers 에 없음")

    for rel in manifest.get("activities", []):
        data = load_json(rel)
        if not data:
            continue
        for act in data.get("activities", []):
            aid = act.get("id", "?")
            std = act.get("standardId")
            if std not in node_by_id:
                errors.append(("E7", f"{rel}: 활동 '{aid}' standardId '{std}' 성취기준 없음"))
                continue
            tpl = act.get("templateType")
            if tpl not in VALID_TPL:
                errors.append(("E7", f"{rel}: 활동 '{aid}' templateType '{tpl}' 미지원 (렌더 불가)"))
            std_skills = skills_by_std.get(std, set())
            if not std_skills:
                warns.append(("W4", f"{rel}: 활동 '{aid}' 대상 '{std}' 의 skills 비어있음 (채점 불가)"))
            units = act.get("steps", []) or act.get("interactions", [])
            if not units:
                errors.append(("E7", f"{rel}: 활동 '{aid}' 채점 단위(steps/interactions) 없음"))
            for i, u in enumerate(units):
                sks = u.get("skillIds") if isinstance(u.get("skillIds"), list) else ([u.get("skillId")] if u.get("skillId") else [])
                if not sks:
                    errors.append(("E7", f"{rel}: 활동 '{aid}' unit[{i}] 수행능력 연결 없음"))
                for sk in sks:
                    if sk not in std_skills and sk not in all_skill_ids:
                        errors.append(("E7", f"{rel}: 활동 '{aid}' unit[{i}] skillId '{sk}' 존재하지 않음"))
                if "kind" in u:
                    check_config(rel, aid, u.get("id", f"#{i}"), u.get("kind"), u.get("config", {}) or {})

    report(node_by_id, seen_edges)


def report(node_by_id=None, seen_edges=None):
    print("=" * 60)
    print("  data/ 무결성 검증 결과")
    print("=" * 60)
    if node_by_id is not None:
        print(f"  노드 {len(node_by_id)}개 · 간선 {len(seen_edges)}개 로드")
        print("-" * 60)

    def dump(title, items):
        if items:
            print(f"\n[{title}] {len(items)}건")
            for code, msg in items:
                print(f"  {code}  {msg}")

    dump("ERROR", errors)
    dump("WARN", warns)

    print("\n" + "-" * 60)
    print(f"  ERROR {len(errors)}건 · WARN {len(warns)}건")
    if not errors:
        print("  ✅ ERROR 0건")
    print("=" * 60)
    sys.exit(1 if errors else 0)


if __name__ == "__main__":
    main()
