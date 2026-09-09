#!/usr/bin/env python3
"""Check the brochure site under site/ before it is deployed.

    python3 tools/check-site.py

Run from check.sh. The site is plain static HTML with no build step at deploy
time, so nothing else would catch any of this until it was live and a search
console started complaining weeks later.

What it asserts, and why each one is here:

  * Every question in a FAQPage block appears, verbatim, in the page a visitor
    actually reads. Google's structured data policy requires marked-up content
    to be visible; markup describing content that is not on the page risks the
    rich result being dropped and, at worst, a manual action. This is not
    hypothetical — the home page shipped on 9 September 2026 with five FAQ
    questions in JSON-LD and no FAQ section on the page.

  * Every JSON-LD block parses. A trailing comma is invisible in a browser and
    silently discards the whole block.

  * Every page carries a canonical URL, an Open Graph image and a title.

  * Every internal link resolves to a file that exists. A 404 from the home
    page is worse than the page not existing.

  * No page references the old .onrender.com host, which would leak the
    unbranded origin into search results and split the domain's authority.

  * The generated pages match tools/build-site.py. Editing a generated page by
    hand works until the next time the generator runs, and then quietly does
    not.
"""
import glob
import hashlib
import json
import os
import re
import subprocess
import sys

SITE = "site"
FAIL = []


def problem(msg):
    FAIL.append(msg)


def ld_blocks(html):
    for m in re.finditer(r'<script type="application/ld\+json">(.*?)</script>', html, re.S):
        yield m.group(1)


def check_page(path):
    html = open(path).read()
    rel = "/" + os.path.relpath(path, SITE).replace("index.html", "").rstrip("/")

    for tag in ('<link rel="canonical"', 'property="og:image"', "<title>"):
        if tag not in html:
            problem(f"{path}: no {tag.strip('<')}")

    if "onrender.com" in html:
        problem(f"{path}: still links to the unbranded .onrender.com host")

    # Structured data must parse, and must describe what is on the page.
    visible = re.sub(r'<script type="application/ld\+json">.*?</script>', "", html, flags=re.S)
    for raw in ld_blocks(html):
        try:
            data = json.loads(raw)
        except json.JSONDecodeError as e:
            problem(f"{path}: a JSON-LD block does not parse ({e})")
            continue
        if data.get("@type") == "FAQPage":
            for q in data.get("mainEntity", []):
                if q["name"] not in visible:
                    problem(f"{path}: FAQ markup claims a question the page does not show — {q['name']!r}")

    # Internal links must land somewhere.
    for href in sorted(set(re.findall(r'href="(/[^"#]*)"', html))):
        target = href.strip("/")
        candidates = [os.path.join(SITE, target, "index.html"), os.path.join(SITE, target)]
        if not any(os.path.exists(c) for c in candidates):
            problem(f"{path}: broken internal link {href}")
    return rel


def main():
    pages = sorted(glob.glob(f"{SITE}/**/index.html", recursive=True))
    if not pages:
        problem("no pages under site/")
    seen = [check_page(p) for p in pages]

    for required in ("robots.txt", "sitemap.xml", "og.png"):
        if not os.path.exists(os.path.join(SITE, required)):
            problem(f"site/{required} is missing")

    # Every page must be in the sitemap, and the sitemap must not promise a
    # page that does not exist.
    if os.path.exists(f"{SITE}/sitemap.xml"):
        listed = set(re.findall(r"<loc>https://checksteady\.ie([^<]*)</loc>", open(f"{SITE}/sitemap.xml").read()))
        listed = {u.rstrip("/") or "/" for u in listed}
        have = {(s.rstrip("/") or "/") for s in seen}
        for missing in sorted(have - listed):
            problem(f"sitemap.xml does not list {missing}")
        for extra in sorted(listed - have):
            problem(f"sitemap.xml lists {extra}, which is not a page")

    # The generated pages must still be what the generator generates.
    before = {p: hashlib.sha256(open(p, "rb").read()).hexdigest() for p in pages}
    subprocess.run([sys.executable, "tools/build-site.py"], capture_output=True, check=True)
    for p, digest in before.items():
        if p == f"{SITE}/index.html":
            continue                       # hand-written, not generated
        if hashlib.sha256(open(p, "rb").read()).hexdigest() != digest:
            problem(f"{p} differs from what tools/build-site.py produces — re-run it and commit the result")

    if FAIL:
        for f in FAIL:
            print(f"  FAIL  {f}")
        print(f"\n{len(FAIL)} problem(s) in the brochure site.")
        sys.exit(1)
    print(f"{len(pages)} pages: structured data visible, links resolve, sitemap complete, generator current")


if __name__ == "__main__":
    main()
