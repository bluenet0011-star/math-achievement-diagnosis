#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""단일파일 번들 생성기 — dist/성취기준진단_단일파일.html

manifest.json의 모든 콘텐츠 JSON을 인라인(<script>window.__BUNDLE__)으로 임베드하고
fetch shim으로 가로채, 더블클릭만으로 열리는 공유용 HTML을 만든다(CDN 라이브러리는 온라인 필요).

보안: 인라인 스크립트에 들어가는 JSON은 반드시 '<'를 \\u003c로 이스케이프한다.
콘텐츠에 '</script' 문자열이 들어와도 스크립트가 조기 종료(HTML 주입)되지 않도록 하는 필수 처리.

실행: python3 tools/build_bundle.py   (프로젝트 루트에서)
"""
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)

man = json.load(open("data/manifest.json", encoding="utf-8"))
bundle = {"data/manifest.json": man}
for k in ("nodes", "edges", "activities", "skillPrereq"):
    for p in man.get(k, []):
        bundle[p] = json.load(open(p, encoding="utf-8"))


def rd(p):
    return open(p, encoding="utf-8").read()


css = rd("css/styles.css")
js_all = "\n".join("/* %s */\n%s" % (f, rd(f)) for f in [
    "js/data.js", "js/templates.js", "js/engine.js", "js/graphview.js", "js/app.js"])

head = ('<link rel="preconnect" href="https://cdn.jsdelivr.net">'
        '<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.css">'
        '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css">'
        '<script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js"></script>'
        '<script defer src="https://cdn.jsdelivr.net/npm/mathjs@12.4.2/lib/browser/math.js"></script>')
body = ('<script src="https://cdn.jsdelivr.net/npm/cytoscape@3.30.2/dist/cytoscape.min.js"></script>'
        '<script src="https://cdn.jsdelivr.net/npm/dagre@0.8.5/dist/dagre.min.js"></script>'
        '<script src="https://cdn.jsdelivr.net/npm/cytoscape-dagre@2.5.0/cytoscape-dagre.min.js"></script>'
        '<script src="https://cdn.jsdelivr.net/npm/elkjs@0.9.3/lib/elk.bundled.js"></script>'
        '<script src="https://cdn.jsdelivr.net/npm/cytoscape-elk@2.2.0/dist/cytoscape-elk.js"></script>'
        '<script src="https://cdn.jsdelivr.net/npm/cytoscape-expand-collapse@4.1.1/cytoscape-expand-collapse.js"></script>')

# '<' 전량 이스케이프 — </script 브레이크아웃 차단 (U+2028/2029도 JS 리터럴 파손 방지)
bj = (json.dumps(bundle, ensure_ascii=False)
      .replace("<", "\\u003c")
      .replace(" ", "\\u2028").replace(" ", "\\u2029"))

shim = ('(function(){var B=window.__BUNDLE__;var _f=window.fetch?window.fetch.bind(window):null;'
        'window.fetch=function(u,o){var key=String(u).split("?")[0].replace(/^\\.\\//,"");'
        'if(B[key]!=null){return Promise.resolve({ok:true,status:200,'
        'json:function(){return Promise.resolve(B[key]);},'
        'text:function(){return Promise.resolve(JSON.stringify(B[key]));}});}'
        'if(_f)return _f(u,o);return Promise.reject(new Error("no fetch"));};})();')

html = ('<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width, initial-scale=1">'
        '<title>수학 성취기준 진단</title>' + head + '<style>' + css + '</style></head>'
        '<body><div class="shell"><div class="frame"><div id="app"></div></div></div>'
        '<script>window.__BUNDLE__=' + bj + ';</script>'
        '<script>' + shim + '</script>' + body + '<script>' + js_all + '</script></body></html>')

out = "dist/성취기준진단_단일파일.html"
os.makedirs("dist", exist_ok=True)
open(out, "w", encoding="utf-8").write(html)
tot = sum(len(json.load(open(p)).get("activities", [])) for p in man["activities"])
raw_lt = html[html.find("window.__BUNDLE__"):html.find(";</script>")].count("<")
print("생성: %s (%.0fKB) · 활동 %d개 · 번들 내 원문 '<' %d개(0이어야 정상)"
      % (out, len(html.encode()) / 1024, tot, raw_lt))
