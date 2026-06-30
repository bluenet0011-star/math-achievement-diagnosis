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

    # ---- 활동 검사(E7)/고아(W4) ----
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
            std_skills = skills_by_std.get(std, set())
            if not std_skills:
                warns.append(("W4", f"{rel}: 활동 '{aid}' 대상 '{std}' 의 skills 비어있음 (채점 불가)"))
            for i, step in enumerate(act.get("steps", [])):
                sk = step.get("skillId")
                if sk not in std_skills:
                    errors.append(("E7", f"{rel}: 활동 '{aid}' step[{i}] skillId '{sk}' 가 '{std}' skills 에 없음"))

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
