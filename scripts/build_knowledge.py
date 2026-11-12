"""Extract FAQ + blog content from the eprpilot.com site repo into data/knowledge.json.
Usage: python3 scripts/build_knowledge.py /path/to/eprpilot-site-repo
"""
import json, sys, os, re
from bs4 import BeautifulSoup

site = sys.argv[1]
BASE = "https://eprpilot.com/"
out = []

def clean(t): return " ".join(t.split())

faq_pages = [("faq.html","pl"),("en/faq.html","en"),("de/faq.html","de")]
for path, lang in faq_pages:
    p = os.path.join(site, path)
    if not os.path.exists(p): continue
    s = BeautifulSoup(open(p, encoding="utf-8").read(), "html.parser")
    url = BASE + path.replace("index.html","")
    for i, d in enumerate(s.find_all("details")):
        q = d.find("summary"); 
        if not q: continue
        question = clean(q.get_text(" "))
        q.extract()
        answer = clean(d.get_text(" "))
        out.append({"id": f"faq-{lang}-{i+1}", "type": "faq", "lang": lang,
                    "title": question, "text": answer, "url": url})

blog_dirs = [("blog","pl"),("en/blog","en")]
for d, lang in blog_dirs:
    full = os.path.join(site, d)
    if not os.path.isdir(full): continue
    for fn in sorted(os.listdir(full)):
        if not fn.endswith(".html"): continue
        s = BeautifulSoup(open(os.path.join(full, fn), encoding="utf-8").read(), "html.parser")
        title = clean(s.title.get_text()) if s.title else fn
        title = re.sub(r"\s*·\s*EPRPilot$", "", title)
        m = s.find("meta", attrs={"name": "description"})
        art = s.find("article") or s.body
        for t in art(["script","style","svg","nav","footer","form"]): t.decompose()
        text = clean(art.get_text(" "))
        out.append({"id": f"blog-{lang}-{fn[:-5]}", "type": "article", "lang": lang,
                    "title": title, "summary": m["content"] if m else "",
                    "text": text[:20000], "url": BASE + d + "/" + fn})

json.dump(out, open(os.path.join(os.path.dirname(__file__), "..", "data", "knowledge.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print(len(out), "entries;", sum(1 for e in out if e["type"]=="faq"), "faq,", sum(1 for e in out if e["type"]=="article"), "articles")
