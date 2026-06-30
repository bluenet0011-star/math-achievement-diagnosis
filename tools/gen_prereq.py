# -*- coding: utf-8 -*-
"""prereq-skills.json(수행능력 단위 선행관계, 진실의 원천) → 성취기준 간선 rollup + 추이적 축소.
   사용: python3 tools/gen_prereq.py  → data/edges/prereq-curated.json 재생성.
   교사가 수행능력 연결을 추가/수정한 뒤 다시 실행하면 계통도가 갱신된다."""
import json, collections, os
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
def J(p): return json.load(open(os.path.join(ROOT,p),encoding="utf-8"))

nodes=J("data/nodes/all-subjects.json")["nodes"]+J("data/nodes/prob-stats.json")["nodes"]
std_of={}
for n in nodes:
    if n.get("type")=="standard":
        for s in n.get("skills",[]): std_of[s["id"]]=n["id"]

E=[(e["from"],e["to"]) for e in J("data/edges/prereq-skills.json")["edges"] if e.get("rel","prerequisite")=="prerequisite"]
bad=[(a,b) for a,b in E if a not in std_of or b not in std_of]
if bad: raise SystemExit("존재하지 않는 skill id: "+str(bad[:20]))

std_edges=set()
for a,b in E:
    sa,sb=std_of[a],std_of[b]
    if sa!=sb: std_edges.add((sa,sb))
adj=collections.defaultdict(set)
for u,v in std_edges: adj[u].add(v)
def reachable(u,v,skip):
    st=[u]; seen=set()
    while st:
        x=st.pop()
        for y in adj[x]:
            if (x,y)==skip: continue
            if y==v: return True
            if y not in seen: seen.add(y); st.append(y)
    return False
reduced=sorted((u,v) for (u,v) in std_edges if not reachable(u,v,(u,v)))
out=[{"from":u,"to":v,"rel":"prerequisite","curated":True} for u,v in reduced]
json.dump({"_comment":"prereq-skills.json에서 rollup+추이적 축소로 자동 생성됨(tools/gen_prereq.py). 직접 편집 금지.","edges":out},
          open(os.path.join(ROOT,"data/edges/prereq-curated.json"),"w",encoding="utf-8"), ensure_ascii=False, indent=0)
print(f"skill 간선 {len(E)} → 성취기준 간선(중복제거) {len(std_edges)} → 추이축소 {len(reduced)}")
