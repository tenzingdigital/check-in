#!/usr/bin/env python3
"""Build the brochure site's inner pages.

    python3 tools/build-site.py

The site under site/ is served by Render as plain static files with NO build
step (render.yaml, checksteady-site). That is deliberate — it cannot break at
deploy time — but it means the shared header, navigation and footer would
otherwise be copy-pasted into every page and drift apart within a month.

So the pages are generated here and the RESULT is committed. Edit this file,
re-run it, and commit both. Two rules the site's Content-Security-Policy
imposes and this file must respect:

  * no JavaScript on the site at all (default-src 'none', no script-src), so
    anything interactive is a <details> or a plain form — with now TWO
    deliberate exceptions:
      1. the Cloudflare Web Analytics beacon, gated by CF_BEACON_TOKEN below.
         It is a single external, deferred file with no inline code, and it
         is inert (nothing is written to the page) while the token is empty;
      2. site/trial-submit.js, loaded only on /trial/ (via page_script= in
         page(), not site-wide). The plain-form-no-JS rule made a real trial
         sign-up look broken on a slow phone connection (10 Sep 2026): tap
         Email me the link, nothing visibly happens until the page navigates,
         so people assumed it had failed and tapped again. The script only
         disables the submit button and relabels it while the POST is in
         flight — it never calls preventDefault(), so the form still submits
         normally if the script fails to load or errors. Both exceptions are
         external, deferred files with no inline code, which is what keeps
         script-src a plain allowlist instead of needing computed hashes;
  * no style="" attributes (style-src 'self'), so every rule lives in
    site/site.css.

site/index.html is NOT generated. It is the hand-written home page and is
edited directly; only the pages listed at the bottom of this file are written.
"""


# Generates the brochure site's inner pages. Run from the repo root:
#   python3 tools/build-site.py
# The site has no build step at deploy time — this writes plain HTML that is
# committed. Re-run it after editing the shared nav, footer or head.
import os, html, json

# The site's own public domain and the app's. DNS is wired and Render is
# serving both live (checked 10 Sep 2026: checksteady.com and
# app.checksteady.com both resolve, through Cloudflare, to the Render
# services below them). The Render addresses (checksteady-site.onrender.com,
# hut-check-in.onrender.com) still exist as the origin behind each one, but
# nothing generated here should reference them — the public, canonical URL
# is the .com one. Changing these two constants plus a regeneration
# (`python3 tools/build-site.py`) is the whole job when a hostname changes.
SITE = "https://checksteady.com"
APP  = "https://app.checksteady.com"
# Display-only form of SITE for the footer ("checksteady.com", no scheme).
SITE_HOST = SITE.split("://", 1)[1]

# Cloudflare Web Analytics beacon token. Empty until the owner creates the
# site at https://dash.cloudflare.com (Web Analytics) and pastes the token
# it gives them here. Chosen over Google Analytics because it is cookieless
# and needs no consent banner. The token is meant to be public — it is not a
# secret, it appears in every page's source once set — so there is no reason
# to keep it out of the repo. With this empty, beacon() below emits nothing
# and the site is byte-for-byte what it was before analytics existed;
# pasting a token in and re-running this file is the whole job.
CF_BEACON_TOKEN = "764f40ae8a8b4ba4a51c618d89701a94"
OUT  = "site"
WRITTEN = []

def beacon():
    """The one JavaScript exception on the site: a single external, deferred
    script with no inline code, emitted only once CF_BEACON_TOKEN is set.
    `defer`, matching Cloudflare's own documented embed exactly — not
    `type="module"`, which happened to also work here but only by two
    coincidences worth not depending on: module scripts fetch in CORS mode,
    which only succeeds because static.cloudflareinsights.com happens to
    send a permissive CORS header, and document.currentScript is null for a
    module script, so beacon.min.js finding its own <script> tag (to read
    data-cf-beacon off it) would rely on an undocumented fallback lookup
    rather than the direct one Cloudflare actually tests against. `defer`
    needs neither."""
    if not CF_BEACON_TOKEN:
        return ""
    return (f'\n<script defer src="https://static.cloudflareinsights.com/beacon.min.js" '
            f'data-cf-beacon=\'{{"token": "{CF_BEACON_TOKEN}"}}\'></script>')

def analytics_note():
    """One honest sentence for the security-and-gdpr page, shown only once
    the beacon above is actually live — never claim tracking that isn't
    happening yet."""
    if not CF_BEACON_TOKEN:
        return ""
    return ('\n    <p>This site — not the app — counts visits using '
            '<a href="https://www.cloudflare.com/en-gb/web-analytics/" '
            'target="_blank" rel="noopener">Cloudflare Web Analytics</a>, which '
            'is cookieless and needs no consent banner: we see only aggregate '
            'counts of page views, never anything tied to one visitor.</p>')

MARK = ('<svg class="mark" viewBox="0 0 64 64" aria-hidden="true">'
        '<rect width="64" height="64" rx="16" fill="#1d4ed8"/>'
        '<path d="M18 33l10 10 18-20" fill="none" stroke="#fff" stroke-width="7" '
        'stroke-linecap="round" stroke-linejoin="round"/></svg>')

NAV_LINKS = [
    ("/features/daily-register/", "Daily register"),
    ("/features/roll-call/",      "Roll call"),
    ("/security-and-gdpr/",       "Security &amp; GDPR"),
    ("/pricing/",                 "Pricing"),
    (APP + "/help.html",          "Help"),
]

def head(title, desc, canon, extra_ld=None, img="/og.png"):
    ld = [{
        "@context": "https://schema.org",
        "@type": "SoftwareApplication",
        "name": "CheckSteady",
        "applicationCategory": "BusinessApplication",
        "operatingSystem": "Web browser, iOS, Android",
        "url": SITE + "/",
        "description": ("The daily welfare register, door log and roll call for hostels, "
                        "supported housing, student residences and care settings."),
        "offers": {"@type": "Offer", "priceCurrency": "EUR",
                   "price": "0", "description": "Free trial, no card required"},
        "publisher": {"@type": "Organization", "name": "Tenzing Digital",
                      "url": "https://www.tenzing.ie"},
    }]
    if extra_ld:
        ld.extend(extra_ld)
    blocks = "\n".join(
        '<script type="application/ld+json">%s</script>' % json.dumps(b, separators=(",", ":"))
        for b in ld)
    return f"""<!doctype html>
<html lang="en-IE">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<meta name="description" content="{desc}">
<link rel="canonical" href="{canon}">
<meta name="robots" content="index, follow, max-image-preview:large">
<meta name="theme-color" content="#1d4ed8">
<meta property="og:title" content="{title}">
<meta property="og:description" content="{desc}">
<meta property="og:type" content="website">
<meta property="og:url" content="{canon}">
<meta property="og:site_name" content="CheckSteady">
<meta property="og:locale" content="en_IE">
<meta property="og:image" content="{SITE}{img}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="CheckSteady — the daily register, showing residents seen, due and needing attention.">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="{title}">
<meta name="twitter:description" content="{desc}">
<meta name="twitter:image" content="{SITE}{img}">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='16' fill='%231d4ed8'/%3E%3Cpath d='M18 33l10 10 18-20' fill='none' stroke='%23fff' stroke-width='7' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E">
<link rel="preload" href="/fonts/plusjakartasans-latin.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/fonts/inter-latin.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/site.css">
{blocks}{beacon()}
</head>"""

def nav():
    links = "\n      ".join(f'<a href="{h}">{t}</a>' for h, t in NAV_LINKS)
    return f"""<div class="topbanner">
  <div class="wrap">
    <span>A <strong>Tenzing Digital</strong> product — AI and automation house</span>
    <a href="https://www.tenzing.ie" target="_blank" rel="noopener">tenzing.ie&nbsp;&rarr;</a>
  </div>
</div>
<header class="sitenav">
  <div class="wrap">
    <a class="brand" href="/">{MARK}CheckSteady</a>
    <nav aria-label="Sections">
      {links}
    </nav>
    <a class="nav-signin" href="{APP}/">Sign in</a>
    <a class="nav-cta" href="/trial/">Start a free trial</a>
  </div>
</header>
<a class="skip" href="#main">Skip to content</a>"""

def foot():
    return f"""<footer class="sitefoot">
  <div class="regstrip" aria-hidden="true">
    <i></i><i></i><i></i><i class="na"></i><i></i><i></i><i></i><i></i><i class="miss"></i><i></i><i></i><i></i><i></i><i class="na"></i><i></i><i></i><i></i><i></i><i></i><i></i><i class="na"></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i>
  </div>
  <div class="wrap footgrid">
    <div class="footcol footcol-brand">
      <span class="footmark">CheckSteady</span>
      <p>The daily welfare register and door log for residential sites — hostels, supported accommodation, care settings. One site or a group.</p>
      <p class="footdomain">{SITE_HOST}</p>
    </div>
    <nav class="footcol" aria-label="Product">
      <h2>Product</h2>
      <a href="/features/daily-register/">Daily register</a>
      <a href="/features/in-and-out/">In &amp; out</a>
      <a href="/features/roll-call/">Roll call</a>
      <a href="/pricing/">Pricing</a>
      <a href="/security-and-gdpr/">Security &amp; GDPR</a>
    </nav>
    <nav class="footcol" aria-label="Who it is for">
      <h2>Who it's for</h2>
      <a href="/for/ipas-accommodation/">IPAS accommodation</a>
      <a href="/for/ukrainian-and-botp-accommodation/">Ukrainian and BOTP accommodation</a>
      <a href="/for/emergency-and-supported-accommodation/">Emergency and supported accommodation</a>
      <a href="/for/homeless-hostels/">Homeless hostels</a>
      <a href="/for/student-residences/">Student residences</a>
      <a href="/for/nursing-homes-and-residential-care/">Nursing homes and residential care</a>
      <a href="/for/refuges-and-treatment-centres/">Refuges and treatment centres</a>
      <a href="/for/visitor-and-contractor-sign-in/">Visitor and contractor sign-in</a>
      <a href="{APP}/help.html">Help and guide</a>
    </nav>
    <div class="footcol">
      <h2>Get started</h2>
      <a class="footsignin" href="/trial/">Start a free trial&nbsp;&rarr;</a>
      <a class="footalt" href="mailto:aimee@tenzing.ie?subject=CheckSteady%20demo">Book a demo</a>
      <a class="footalt" href="{APP}/">Sign in</a>
    </div>
  </div>
  <div class="footbar">
    <div class="wrap">
      <span>&copy; 2026 Tenzing Digital</span>
      <span>Also from Tenzing: <a href="https://www.staffsteady.com" target="_blank" rel="noopener">StaffSteady</a>, rotas, HR and clock-in.</span>
      <span>Built by <a href="https://www.tenzing.ie" target="_blank" rel="noopener">Tenzing Digital</a>, an AI and automation house.</span>
    </div>
  </div>
</footer>
</body>
</html>"""

def crumb(trail):
    parts = []
    for i, (href, label) in enumerate(trail):
        if href:
            parts.append(f'<a href="{href}">{label}</a>')
        else:
            parts.append(label)
    return '<div class="wrap"><p class="crumb">' + '<span>/</span>'.join(parts) + '</p></div>'

def faq_ld(items):
    return {"@context": "https://schema.org", "@type": "FAQPage",
            "mainEntity": [{"@type": "Question", "name": q,
                            "acceptedAnswer": {"@type": "Answer", "text": a}}
                           for q, a in items]}

def faq_html(items):
    rows = "\n".join(
        f"    <details>\n      <summary>{q}</summary>\n      <p>{a}</p>\n    </details>"
        for q, a in items)
    return f'  <div class="faq">\n{rows}\n  </div>'

def page(path, title, desc, trail, body, faqs=None, breadcrumb_ld=True, page_script=None):
    canon = SITE + path
    extra = []
    if faqs:
        extra.append(faq_ld(faqs))
    if breadcrumb_ld and len(trail) > 1:
        extra.append({
            "@context": "https://schema.org", "@type": "BreadcrumbList",
            "itemListElement": [
                {"@type": "ListItem", "position": i + 1, "name": html.unescape(lbl),
                 "item": SITE + (href or path)}
                for i, (href, lbl) in enumerate(trail)],
        })
    doc = head(title, desc, canon, extra) + "\n<body>\n" + nav() + "\n<main id=\"main\">\n"
    doc += crumb(trail) + "\n" + body + "\n</main>\n" + foot()
    if page_script:
        # Deliberately per-page, not in head()/foot(): see the JavaScript
        # exceptions noted in this file's module docstring. Deferred, so it
        # never blocks rendering, and placed at the end of body so the form
        # it enhances already exists when it runs.
        doc = doc.replace("</body>\n</html>", f'<script defer src="{page_script}"></script>\n</body>\n</html>')
    full = os.path.join(OUT, path.strip("/"), "index.html") if path != "/" else os.path.join(OUT, "index.html")
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, "w") as f:
        f.write(doc)
    WRITTEN.append(full)
    return full


# --------------------------------------------------------------------------
# Pages
# --------------------------------------------------------------------------
HOME = ("/", "Home")
def sec(inner, tint=False, first=False):
    cls = "section tint" if tint else "section"
    return f'<section class="{cls}">\n  <div class="wrap">\n{inner}\n  </div>\n</section>'

def phead(eyebrow, h1, lede):
    return (f'<section class="pagehead">\n  <div class="wrap">\n'
            f'    <p class="eyebrow">{eyebrow}</p>\n    <h1>{h1}</h1>\n'
            f'    <p class="lede">{lede}</p>\n  </div>\n</section>')

def nextlinks(title, items):
    cards = "\n".join(
        f'    <a href="{h}"><b>{t}</b><span>{d}</span></a>' for h, t, d in items)
    return (f'<section class="section tint">\n  <div class="wrap">\n    <h2>{title}</h2>\n'
            f'    <div class="nextlinks">\n{cards}\n    </div>\n  </div>\n</section>')

CTA = ('<section class="section">\n  <div class="wrap">\n'
       '    <h2>Try it on your own site</h2>\n'
       '    <p>Start a free trial and have a look around — with sample residents to explore, '
       'or empty and ready for your own list. No card, and nothing to install.</p>\n'
       '    <p><a class="cta" href="/trial/">Start a free trial</a>'
       '<a class="cta-secondary" href="mailto:aimee@tenzing.ie?subject=CheckSteady%20demo">Book a demo instead</a></p>\n'
       '  </div>\n</section>')

# --------------------------------------------------------------------------
# /features/daily-register/
# --------------------------------------------------------------------------
faqs = [
 ("What counts as a check-in?",
  "One presentation by a resident on a given day, recorded by a staff member with one tap or one swipe. Repeat taps within a minute are folded into the same presentation, so a double tap does not create a second record. The day's count is kept, so a resident seen twice shows as seen twice."),
 ("What happens if a resident is not seen?",
  "At local midnight — the site's own timezone, computed on the server — anyone who was required to check in and was not seen becomes a recorded miss. Nothing depends on a staff member remembering to close the day, and a tablet with a wrong clock cannot shift what today means."),
 ("Can a check-in be edited or deleted?",
  "No. Check-ins are append-only and cannot be changed or removed by anyone, including an administrator. A correction is a new record, not an edit of an old one. This is what makes the register usable as evidence."),
 ("Does it decide when someone has breached the rules?",
  "No, and that is deliberate. CheckSteady shows the count beside the figure in your settings — three consecutive nights, ten days absent in twenty-eight — and stops there. The decision, and the letter, stay with the manager."),
 ("Can a resident be exempt from checking in?",
  "Yes. Residents under the adult age you set are shown as not required. An authorised absence can be recorded with a return date, and while it runs the register shows the resident as away rather than missing."),
]
body = (
  phead("Feature", "The daily register",
        "One check-in per resident per day, recorded in two taps, closed automatically at midnight, and impossible to edit afterwards.") +
  sec("""    <h2>What your staff see</h2>
    <p>The whole register is on screen before anyone types. Every resident is listed, ordered by surname with letter separators down the side, and typing a name filters instantly — the search forgives typos, missing accents and names given in either order. One tap records the check-in; on a tablet, a swipe does the same thing without looking away.</p>
    <p>Each card says the one thing that matters at that moment: seen today and at what time, not yet seen, due today, never yet seen, away until a date, or not required. The confirmation is immediate and specific.</p>
    <div class="pairs">
      <div><h3>Two taps, not a form</h3><p>Find the name, record the check-in. Nothing else is asked at the door, because nothing else can be answered honestly while somebody is standing at the window.</p></div>
      <div><h3>Attributed, always</h3><p>Every entry carries who recorded it and when. Nobody can act as somebody else, and the detail sheet lists each of the day's check-ins with the staff member's name against it.</p></div>
      <div><h3>Works with no connection</h3><p>If the wifi drops, the card says Queued and the register keeps working. Entries send themselves when the connection returns; nothing is silently lost.</p></div>
      <div><h3>Thirty days at a glance</h3><p>Each resident's last thirty days as a strip: seen, missed, or not required. A pattern is visible before it becomes a problem.</p></div>
      <div><h3>Human error, put right</h3><p>Wrong entry? Any staff member can take it off the register with a reason — it stays on the audit trail — and add a missed one at the time it happened.</p></div>
    </div>""") +
  sec("""    <h2>The morning list</h2>
    <p>Managers do not go looking. Consecutive missed nights and days absent in the window are counted for every resident and listed worst-first, each figure shown beside the threshold in your settings. Authorised absences are excluded, because an approved absence is not a missed night.</p>
    <p>Where a centre issues breach notices, the last one issued is shown beside the count, so nobody sends a second letter for the same run of nights.</p>
    <h2>Getting your list in</h2>
    <p>Import the spreadsheet you already keep. Every line is previewed with a verdict before anything is written — ready, already on the register, or the exact problem to fix — and rooms, ID numbers and evacuation needs come across with it. Fix a line and import the same sheet again; nobody is ever added twice.</p>""", tint=True) +
  sec('    <h2>Common questions</h2>\n' + faq_html(faqs)) +
  CTA +
  nextlinks("Also in CheckSteady", [
    ("/features/in-and-out/", "In &amp; out", "Who is on site right now, and every movement with a name and a time on it."),
    ("/features/roll-call/", "Roll call", "Mark people safe on every warden's phone at once, with or without a connection."),
    ("/security-and-gdpr/", "Security and GDPR", "Append-only records, subject access exports, scheduled erasure, EU hosting."),
  ]))
page("/features/daily-register/",
     "The daily register — CheckSteady",
     "A daily welfare register for residential sites: one check-in per resident per day in two taps, misses recorded automatically at midnight, and records that can never be edited.",
     [HOME, ("/features/daily-register/", "Daily register")], body, faqs)

# --------------------------------------------------------------------------
# /features/roll-call/
# --------------------------------------------------------------------------
faqs = [
 ("Does it work if the wifi is down?",
  "Yes. Each warden's phone holds the list of everyone recorded on site and marks people safe without a connection. When the network returns the marks merge, so two wardens who marked the same person do not create a conflict."),
 ("Do all the wardens see the same list?",
  "Yes. A roll call started on one phone appears on every other phone on site within seconds, and ticks appear on each other's screens as people are found. One roll call runs at a time, and ending it on one phone ends it everywhere."),
 ("Are drills recorded differently from real evacuations?",
  "Yes. A roll call is started as either a practice drill or a real evacuation, the screen says which in plain words throughout, and the record keeps that distinction. A note can be added when it ends."),
 ("What about people who need help to evacuate?",
  "Residents recorded as needing assistance — to move, to hear the alarm, to find the way, or as an infant or carer — are first on every list with the need beside the name, and a counter shows how many of them are still to be found."),
 ("Does it include staff, visitors and contractors?",
  "Yes, where the visitors feature is on. Anyone signed in and not yet signed out appears on the roll call in their own group, so the count is everyone on site, not only residents."),
]
body = (
  phead("Feature", "Roll call",
        "One tap starts a drill or a real evacuation. Every warden's phone shows the same list, marks merge, and it works with no connection.") +
  sec("""    <h2>At the assembly point</h2>
    <p>Starting a roll call puts everyone recorded on site onto every warden's phone. Wardens mark people safe as they see them — a tap, or a swipe — and a counter at the top says how many are accounted for and how many are still to find.</p>
    <p>The list is grouped by building, so a warden at one assembly point can see just their block, and can filter further by name or room. Families stay together, children marked, so nobody is left looking for a five-year-old on a separate line.</p>
    <div class="pairs">
      <div><h3>Assistance first</h3><p>Anyone who needs help to evacuate is at the top of the list with the need named, and a single tap filters the screen down to only those people.</p></div>
      <div><h3>Practice or real, never ambiguous</h3><p>The banner says which, in words, for the whole roll call. The record keeps the distinction, so a drill is never mistaken for an incident afterwards.</p></div>
      <div><h3>No connection needed</h3><p>The list is already on the phone. Marks made offline merge when the network returns, and marking someone twice is harmless.</p></div>
      <div><h3>Printable</h3><p>The list prints as a paper roll call sheet with the safe ticks on it, for the file or for a fire officer who wants paper.</p></div>
    </div>""") +
  sec("""    <h2>Afterwards</h2>
    <p>Ending a roll call keeps the record: who was on site, who was marked safe and when, who was still to find, and whether it was a drill or a real event. A note can be added at the end. The marked-safe report puts that on paper or into a spreadsheet for the fire file.</p>""", tint=True) +
  sec('    <h2>Common questions</h2>\n' + faq_html(faqs)) +
  CTA +
  nextlinks("Also in CheckSteady", [
    ("/features/daily-register/", "Daily register", "One check-in per resident per day, closed automatically at midnight."),
    ("/features/in-and-out/", "In &amp; out", "The live count of who is on site that the roll call is built from."),
    ("/for/homeless-hostels/", "For homeless hostels", "How the register, the door log and the roll call fit a hostel's night."),
  ]))
page("/features/roll-call/",
     "Roll call and fire evacuation — CheckSteady",
     "Start a drill or a real evacuation from one phone and every warden sees the same list. Mark people safe with one tap, offline, with residents needing assistance first.",
     [HOME, ("/features/roll-call/", "Roll call")], body, faqs)

# --------------------------------------------------------------------------
# /features/in-and-out/
# --------------------------------------------------------------------------
faqs = [
 ("How is this different from the daily register?",
  "They answer different questions and are kept as separate records. In and out says where somebody is right now — the fire-drill question. The daily register says whether somebody has been seen today at all, which is the welfare and compliance question. A resident can be off site and still have checked in."),
 ("Can staff sign several people in at once?",
  "Yes. Select several lets you tick people and sign them in or out together — a minibus returning, a family arriving. Each person still gets their own movement, with their own time and the staff member's name; the shortcut is on the screen, not in the record."),
 ("Is there a log of movements?",
  "Yes. Every movement for any day or range of days, newest first, with the time, the direction and who recorded it. It exports as a spreadsheet."),
 ("Does it cover staff, visitors and contractors?",
  "Yes, where the visitors feature is on. Staff, visitors, contractors and suppliers are signed in on arrival and out when they leave, and anyone still on site appears on the roll call."),
]
body = (
  phead("Feature", "In &amp; out",
        "Who is on site right now, and every movement with a name and a time on it — the record the roll call is built from.") +
  sec("""    <h2>The live count</h2>
    <p>A separate screen from the daily register, and deliberately so: this one answers <em>where is everybody</em>, not <em>has everybody been seen</em>. Tiles at the top count who is on site, who is off site, and who has moved today, and each one is a filter.</p>
    <p>A swipe right signs someone in, a swipe left signs them out. Residents on an authorised absence show as away with their return date. Every movement carries the staff member who recorded it.</p>
    <div class="pairs">
      <div><h3>A group at once</h3><p>A minibus back from an outing, a family arriving together: tick several people and sign them all in or out in one action, each with their own recorded movement.</p></div>
      <div><h3>The day's log</h3><p>Every movement for a day or a range, newest first, with the time and the staff member. Quick ranges for today, this week and last month, and a spreadsheet export.</p></div>
      <div><h3>Visitors too</h3><p>Staff, contractors and suppliers signed in on arrival and out on departure, with an optional company — so the on-site count is everyone, not only residents.</p></div>
      <div><h3>Rooms, where you use them</h3><p>Buildings, floors and rooms with bed counts and occupancy, searchable by room number, and a vacancies report for the beds you can actually offer.</p></div>
    </div>""") +
  sec('    <h2>Common questions</h2>\n' + faq_html(faqs)) +
  CTA +
  nextlinks("Also in CheckSteady", [
    ("/features/roll-call/", "Roll call", "The evacuation list, built from who is recorded on site."),
    ("/features/daily-register/", "Daily register", "The welfare and compliance record, kept separately."),
    ("/pricing/", "Pricing", "Per site, per month. Every feature included."),
  ]))
page("/features/in-and-out/",
     "In &amp; out — the door log — CheckSteady",
     "A live count of who is on site, with every movement timestamped and attributed. Sign groups in and out together, log visitors and contractors, export any day.",
     [HOME, ("/features/in-and-out/", "In &amp; out")], body, faqs)

# --------------------------------------------------------------------------
# /for/ipas-accommodation/
# --------------------------------------------------------------------------
faqs = [
 ("Does it record TRC and IRP numbers?",
  "Yes. A resident's identity document is recorded as either a TRC or an IRP with the number as printed on the card. The number is never shown in a list — only on the resident's own record, opened deliberately, and every opening is logged."),
 ("Can we show an inspector what happened on a given day?",
  "Yes. The register for any date, the movement log for any range, occupancy, drills and marked-safe lists all print or export as spreadsheets. Because records are append-only, what you show is what was recorded at the time."),
 ("Does it decide that a resident has breached house rules?",
  "No. It counts consecutive missed nights and days absent in your window, and shows each count beside the figure in your settings. The judgement and the letter stay with the manager, and any notice issued is recorded against the resident so a second one is not sent for the same run."),
 ("Can residents be away with permission without it counting against them?",
  "Yes. An authorised absence is recorded with a return date. While it runs the register shows the resident as away rather than missing, and the absence is excluded from the missed-night counts."),
 ("Where is the data held?",
  "In the European Union — Frankfurt — encrypted in transit and at rest. Each centre's records live in their own separate database schema, so one centre's staff cannot reach another's data even by accident."),
 ("What is the weekly register update?",
  "A Sunday-morning email to the staff you choose with counts of resident absences, weekend updates, removals and room updates over the past week, and a link to the full report. The email itself carries counts and a link; the update also arrives attached as a Word document — the same five sections, one sentence per resident, ready to review and forward — on by default, and a centre can turn that off. The report also downloads from the app as a spreadsheet or a Word document."),
 ("Is this built for direct provision centres specifically?",
  "It was built with the feedback of an accommodation centre manager, and the vocabulary — permitted absences, house rules, TRC and IRP, contracted beds — is that of IPAS-contracted accommodation. The same register works for any residential centre that keeps a daily record of who was seen."),
]
body = (
  phead("Who it's for", "For IPAS and direct provision accommodation centres",
        "The daily register, the weekly register update and the door log an International Protection Accommodation Services (IPAS) centre keeps anyway — kept by the app, ready for an inspection, and written in the vocabulary a centre manager already uses.") +
  sec("""    <h2>Built around what an IPAS centre actually does</h2>
    <p>CheckSteady was built with an accommodation centre manager, and the vocabulary is theirs. Residents check in once a day; the day closes itself at local midnight; missed nights are counted against the figure your contract or your house rules use, not against one we invented.</p>
    <div class="pairs">
      <div><h3>Identity documents, minimally</h3><p>TRC or IRP, recorded as printed. Never shown in a list, never in an export that does not need it, and every time the number is fetched it is logged.</p></div>
      <div><h3>Families kept together</h3><p>Households group parents and children. A family stays together on the roll call with children marked, and a room reads as a family rather than four unrelated names.</p></div>
      <div><h3>House rules, counted not judged</h3><p>Consecutive nights and days absent in a window, each beside the figure in your settings. Breach notices issued are recorded so nobody sends two.</p></div>
      <div><h3>Rooms and contracted beds</h3><p>Buildings, floors and rooms, with physical beds and contracted beds held separately, plus the bed set-up and a vacancies report for what you can actually offer.</p></div>
      <div><h3>Permitted absence periods</h3><p>The dates IPAS notifies — Christmas, Ramadan, Easter, the summer holiday — are recorded once; a holiday authorised outside them still goes through, with a warning on the screen, never a refusal.</p></div>
      <div><h3>The weekly register update</h3><p>Every Sunday morning the staff you tick receive counts of resident absences, weekend updates, removals and room changes, with a link into the app, and the full update attached as a Word document naming residents and rooms — on by default, though a centre can turn that off. The full report is also in the app and downloads as a spreadsheet or a Word document.</p></div>
    </div>""") +
  sec("""    <h2>What an IPAS inspection asks for</h2>
    <p>Every register record CheckSteady keeps is append-only: check-ins, movements, drills and notices cannot be edited or deleted afterwards, by anyone, including an administrator. That is the property that makes a register worth showing. Alongside it: the register for any date, the movement log for any range, occupancy over time, drill and evacuation records with who was marked safe and when, and a full file for any individual resident. One printable document gathers the weekly register, vacancies, breaches and the evacuation list for a date range.</p>
    <h2>Children away overnight, and the nightly email</h2>
    <p>Children are on the daily register but are not required to check in — the app requires a check-in only from adults — so the app derives an overnight absence from the In &amp; out register instead. One nightly email to the staff you tick names, in its body, each household with children on site and no guardian (family, room, children with ages, adults signed out and when the first of them left), each child away overnight with no authorised absence, each check-in recorded while the person was signed out at the gate, and each resident at the house rules figures — with a link into the app alongside each. One switch, on where the centre already received the emails it replaces, and off otherwise. All of it is a record of what the centre has, not a judgement that anything is wrong.</p>""", tint=True) +
  sec("""    <h2>Getting started without a project</h2>
    <p>Import the spreadsheet you already keep — names, dates of birth, rooms, ID numbers, evacuation needs — and see a verdict for every line before anything is written. Turn on only the parts you use: rooms, families, visitors and evacuation needs are each a switch, and a centre that leaves one off never sees it.</p>""") +
  sec('    <h2>Common questions</h2>\n' + faq_html(faqs)) +
  CTA +
  nextlinks("Read next", [
    ("/features/daily-register/", "Daily register", "One check-in per resident per day, closed automatically at midnight."),
    ("/for/emergency-and-supported-accommodation/", "Emergency and supported accommodation", "Section 10 hostels, family hubs and AHB housing keep the same register."),
    ("/security-and-gdpr/", "Security and GDPR", "Append-only records, subject access, scheduled erasure, EU hosting."),
  ]))
page("/for/ipas-accommodation/",
     "CheckSteady for IPAS accommodation centres — daily register, weekly register and inspection records",
     "The daily register, Sunday weekly register update, door log and roll call for IPAS and direct provision centres — append-only records for inspection.",
     [HOME, ("/for/ipas-accommodation/", "IPAS accommodation")], body, faqs)

# --------------------------------------------------------------------------
# /for/homeless-hostels/
# --------------------------------------------------------------------------
faqs = [
 ("Can staff use it on a phone at a hatch?",
  "Yes. It is built phone-first for exactly that: standing, one hand free, at any hour. The whole list is on screen before anyone types, and a check-in is one tap or one swipe."),
 ("What if the connection drops?",
  "It keeps working. Check-ins and movements queue on the device, the card says Queued, and everything sends when the connection returns. Nothing is lost and nothing needs remembering."),
 ("Can we see who is in the building right now?",
  "Yes — that is the In and out screen, with a live count and a full movement log. It is also what the roll call is built from, so a fire alarm at 3am does not need anyone to prepare a list."),
 ("Does it work for a bed-night service where people come and go?",
  "Yes. Residents can be marked departed and archived without losing their history, rooms carry bed counts and occupancy, and the vacancies report says what you can actually offer tonight."),
]
body = (
  phead("Who it's for", "For homeless and emergency hostels",
        "A register a staff member can work at a hatch, on a phone, at three in the morning, with the wifi down.") +
  sec("""    <h2>Designed for the doorway, not the desk</h2>
    <p>Most of this software's day happens standing up. The register opens with everyone already on screen, the search forgives typos and missing accents, and recording somebody takes one tap. The screen says what it just recorded, in words, immediately.</p>
    <div class="pairs">
      <div><h3>Night-shift legible</h3><p>Light and dark both, following the device. Large names, one action per screen, and colours that mean the same thing on every screen.</p></div>
      <div><h3>Offline by default</h3><p>The list is already on the device. A dropped connection changes the colour of one pill and nothing else about the job.</p></div>
      <div><h3>Who is in, right now</h3><p>A live count and a movement log with a name against every entry — and the roll call is built from it, ready before the alarm goes.</p></div>
      <div><h3>Beds and vacancies</h3><p>Rooms with bed counts and occupancy, and a vacancies report for what is genuinely free tonight.</p></div>
    </div>
    <h2>Records that hold up</h2>
    <p>Check-ins and movements are append-only — no edits, no deletions, by anyone. Each carries who recorded it and when. When a funder, an inspector or a coroner asks what happened on a particular night, the answer is the record as it was made, not a version of it.</p>""") +
  sec('    <h2>Common questions</h2>\n' + faq_html(faqs)) +
  CTA +
  nextlinks("Read next", [
    ("/features/in-and-out/", "In &amp; out", "The live on-site count and the movement log."),
    ("/features/daily-register/", "Daily register", "One check-in per resident per day, closed at midnight."),
    ("/security-and-gdpr/", "Security and GDPR", "What is held, who can see it, and how it is erased."),
  ]))
page("/for/homeless-hostels/",
     "CheckSteady for homeless and emergency hostels",
     "A phone-first resident register and door log for hostels: works offline, one-tap check-ins at the hatch, a live on-site count, bed vacancies and append-only records.",
     [HOME, ("/for/homeless-hostels/", "Homeless hostels")], body, faqs)

# --------------------------------------------------------------------------
# /for/student-residences/
# --------------------------------------------------------------------------
faqs = [
 ("Do we have to use the daily check-in?",
  "Not as a separate act. The register cannot be switched off, but with the door switch on a sign-in at the door counts as the day's check-in, so a residence that only wants the door log and the roll call records nothing twice."),
 ("Can we run several blocks from one account?",
  "Yes. Buildings, floors and rooms are built in. The roll call groups by building so a warden at one assembly point sees only their block, and occupancy and vacancy reporting work per building."),
 ("How do fire drills work?",
  "One tap starts a drill; every warden's phone shows the same list and marks merge as people are found. The drill is kept as a record, marked as practice rather than a real evacuation, and prints for the fire file."),
 ("Is it suitable for under-18s?",
  "Residents under the adult age you set are shown as not required for the daily check-in, and appear as children within their family group on the roll call."),
]
body = (
  phead("Who it's for", "For student residences and halls",
        "Who is in which block, a fire roll call that works on every warden's phone, and occupancy you can report on.") +
  sec("""    <h2>Blocks, floors and rooms</h2>
    <p>A residence is not one list. Buildings, floors and rooms are first-class: rooms carry physical beds, contracted beds and the bed set-up, occupancy is counted per building, and searching a room number finds the people in it.</p>
    <div class="pairs">
      <div><h3>Roll call by block</h3><p>Wardens filter to their own building at their own assembly point. Counts are per group, and the whole list merges across phones.</p></div>
      <div><h3>Take only what you need</h3><p>The door can be the check-in. With the door switch on, a sign-in at the door records the day's check-in, so a residence that only works the door log and the roll call keeps an honest register without a second act.</p></div>
      <div><h3>Visitors and contractors</h3><p>Signed in on arrival, out on departure, and included in the on-site count that the roll call uses.</p></div>
      <div><h3>Occupancy reporting</h3><p>Occupancy over a range, vacancies as they stand, and room history showing who was in a room and when.</p></div>
    </div>""") +
  sec('    <h2>Common questions</h2>\n' + faq_html(faqs)) +
  CTA +
  nextlinks("Read next", [
    ("/features/roll-call/", "Roll call", "Drills across every warden's phone, grouped by building."),
    ("/features/in-and-out/", "In &amp; out", "The live on-site count and movement log."),
    ("/pricing/", "Pricing", "Per site, per month, every feature included."),
  ]))
page("/for/student-residences/",
     "CheckSteady for student residences and halls",
     "Know who is in which block, run fire roll calls on every warden's phone at once, and report occupancy and vacancies per building.",
     [HOME, ("/for/student-residences/", "Student residences")], body, faqs)

# --------------------------------------------------------------------------
# /for/emergency-and-supported-accommodation/
# --------------------------------------------------------------------------
faqs = [
 ("Does it work for a family hub?",
  "Yes. Households group parents and children together, so a family stays together on the register and on the roll call. Children are on the daily register, marked not required rather than left off it, and a room reads as a family rather than four unrelated names."),
 ("Can a keyworker see who was seen today without the desk?",
  "Yes. Any staff account, on any phone, opens the same register — who has been seen today and who has not been seen. The record does not live at one desk."),
 ("Is this a case-management or support-plan system?",
  "No — it records presence and movement: who was seen, who moved in or out, who is on site. It holds no notes about a person's circumstances, care needs or support plan."),
 ("Where is the data held?",
  "In the European Union — Frankfurt — encrypted in transit and at rest. Each service's records live in their own separate database schema, so one service's staff cannot reach another's data even by accident."),
]
body = (
  phead("Who it's for", "For emergency accommodation, family hubs and supported housing",
        "The same register a hostel keeps, in a setting where many of the people on it are families rather than single adults — and where a keyworker, a scheme coordinator and a local authority all need to know who was seen today.") +
  sec("""    <h2>The register an emergency accommodation service keeps</h2>
    <p>One check-in per resident per day, closed automatically at local midnight, with anyone not seen recorded as a miss without anyone needing to remember to close the day. Where a resident is away with permission, an authorised absence with a return date keeps the register showing them as away rather than missing.</p>
    <div class="pairs">
      <div><h3>Families in a hub</h3><p>Households group parents and children. Children are on the daily register, marked not required rather than left off it, and a room reads as a family rather than four unrelated names.</p></div>
      <div><h3>Keyworkers and visitors</h3><p>Staff on the site's list are signed in with one tap on the Visitors tab. Visitors, contractors and suppliers are signed in and out with their kind, name and an optional company, and a live count says how many are on site right now.</p></div>
      <div><h3>Bed nights and vacancies</h3><p>Buildings, floors and rooms, with physical beds and contracted beds held separately, occupancy at a glance, and a vacancies report for what the service can actually offer tonight.</p></div>
      <div><h3>What a local authority may ask</h3><p>The register for any date, the movement log for any range, and occupancy — each one exports as a spreadsheet.</p></div>
    </div>""") +
  sec("""    <h2>Supported and sheltered housing run by an approved housing body</h2>
    <p>Supported and sheltered housing needs a lighter touch than a hostel, and CheckSteady scales down to it: a daily "seen" check-in per tenant, a door log where the scheme keeps a desk, and a roll call grouped by building for a fire drill. The parts a scheme does not use — visitors, households and the rest — stay switched off.</p>
    <p>What it is not: a tenancy or rent system, and not a record of a support plan. It records that someone was seen and where they moved, not what a keyworker is helping them with.</p>""", tint=True) +
  sec('    <h2>Common questions</h2>\n' + faq_html(faqs)) +
  CTA +
  nextlinks("Read next", [
    ("/for/homeless-hostels/", "Homeless hostels", "The same register at a hatch, phone-first and built for the night shift."),
    ("/for/ipas-accommodation/", "IPAS accommodation", "The same register, in the vocabulary an IPAS-contracted centre uses."),
    ("/features/roll-call/", "Roll call", "Fire drills and evacuations on every warden's phone, offline."),
  ]))
page("/for/emergency-and-supported-accommodation/",
     "CheckSteady for emergency accommodation, family hubs and supported housing",
     "The daily register, door log and roll call for Section 10 emergency accommodation, family hubs and supported and sheltered housing — offline, EU hosted.",
     [HOME, ("/for/emergency-and-supported-accommodation/", "Emergency and supported accommodation")], body, faqs)

# --------------------------------------------------------------------------
# /for/ukrainian-and-botp-accommodation/
# --------------------------------------------------------------------------
faqs = [
 ("Can one site hold both IPAS and BOTP residents?",
  "Yes. One register, one set of buildings and rooms — rooms and buildings tell the two groups apart if the centre wants to see that distinction, but the app itself holds no immigration-status field."),
 ("Do residents need an app or a phone?",
  "No. Staff record every check-in, movement and roll call from their own device. Residents are not asked to install anything or carry anything."),
 ("Does it record PPS numbers or bank details?",
  "No — neither is collected anywhere in the app. A resident's identity document is recorded as a TRC or an IRP, as printed, and only if the centre chooses to record it — the field is optional."),
 ("How long does it take to set up?",
  "Import the spreadsheet you already keep — a verdict is shown for every line before anything is written — and turn on only the parts the centre uses. Nothing else is required to start."),
]
body = (
  phead("Who it's for", "For Ukrainian and temporary protection (BOTP) accommodation",
        "Often the same operator, and often the same building, as an IPAS centre — the register a contract or an inspection asks for, without a second system.") +
  sec("""    <h2>One register for a mixed site</h2>
    <p>A site housing both beneficiaries of temporary protection and IPAS residents does not need two registers. Buildings and rooms hold both, the daily check-in and the In &amp; out door log work the same way for everyone on site, and a room shows who is actually in it, whichever scheme they arrived under.</p>
    <div class="pairs">
      <div><h3>Families and rooms</h3><p>Households group parents and children, a room reads as a family, and children are on the daily register, marked not required rather than left off it.</p></div>
      <div><h3>Contracted beds and vacancies</h3><p>Physical beds and contracted beds held separately, room status open or under maintenance with a note, and a vacancies report for what the centre can actually offer.</p></div>
      <div><h3>Weekly register update</h3><p>Every Sunday morning the staff you choose get an email with counts of absences, weekend updates, removals and room changes, and a link into the app, with the full update also attached as a Word document naming residents and rooms — on by default, though you can turn that off.</p></div>
      <div><h3>Records for the Department</h3><p>Append-only check-ins, movements and drills, plus the register for any date and occupancy, export as spreadsheets — for the contracting Department, or for your own contract review.</p></div>
    </div>""") +
  sec("""    <h2>Moving on and moving in</h2>
    <p>Residents move on. Marking someone departed archives them without losing their history, so a past resident's record is still there for the retention period if it is asked for. Bringing a new list in uses the same import throughout the app: a spreadsheet with a verdict shown for every line before anything is written, and a resident reference of the app's own for anyone the spreadsheet needs to refer to.</p>""", tint=True) +
  sec('    <h2>Common questions</h2>\n' + faq_html(faqs)) +
  CTA +
  nextlinks("Read next", [
    ("/for/ipas-accommodation/", "IPAS accommodation", "The register in an IPAS centre's own vocabulary — permitted absences, house rules, contracted beds."),
    ("/features/daily-register/", "Daily register", "One check-in per resident per day, closed automatically at midnight."),
    ("/pricing/", "Pricing", "Per site, per month, every feature included."),
  ]))
page("/for/ukrainian-and-botp-accommodation/",
     "CheckSteady for Ukrainian and temporary protection accommodation centres",
     "The daily register, door log and roll call for Ukrainian and temporary protection (BOTP) accommodation — the same register an IPAS centre keeps. EU hosted.",
     [HOME, ("/for/ukrainian-and-botp-accommodation/", "Ukrainian and BOTP accommodation")], body, faqs)

# --------------------------------------------------------------------------
# /for/nursing-homes-and-residential-care/
# --------------------------------------------------------------------------
faqs = [
 ("Is this a care-planning or medication system?",
  "No. CheckSteady holds no care plans, medication records or nursing notes, and does not try to. It records presence and movement only — who was on the premises, who came and went, and who was marked safe at a drill."),
 ("Can residents who go out with family be recorded?",
  "Yes. A day out is a movement on the In and out log; a night or longer away is recorded as an authorised absence with a return date, so the register shows the resident as away rather than missing."),
 ("Does it hold health information?",
  "Only if the centre turns the feature on: an evacuation-need code from a fixed list, recorded so a warden knows who needs help at a drill. It is a special-category field, and the centre records it in its own DPIA — CheckSteady does not decide that for it."),
 ("Can it be used on a tablet at reception?",
  "Yes. It installs to a tablet's home screen for a fixed station at reception, and works the same way on any staff phone."),
]
body = (
  phead("Who it's for", "For nursing homes and residential care centres",
        "A designated centre should be able to answer three questions in a minute: who is in the building, who has visited today, and who is accounted for if the alarm goes. CheckSteady keeps the register that answers all three, instead of a book at reception.") +
  sec("""    <h2>The register beside the care record</h2>
    <p>CheckSteady is not a care plan, a medication record or a nursing record, and it does not try to be. It records presence and movement: who is on the premises, who came and went, and who was marked safe at a drill. It sits beside the care system, not inside it.</p>
    <div class="pairs">
      <div><h3>Fire register, always current</h3><p>Residents by building, floor and room, each with an evacuation-need code where the centre records one, and a roll call that groups by building for the assembly point.</p></div>
      <div><h3>Visitors and contractors</h3><p>Signed in with their kind, name and company, signed out on departure, and included in the roll call for as long as they are on site.</p></div>
      <div><h3>Drills and evacuations</h3><p>Started from any warden's phone, working offline, with the marked-safe list merging across every phone afterwards. The record — who was found, and when — is kept.</p></div>
      <div><h3>Who is in right now</h3><p>A live count and a movement log with a name against every entry, the same record the roll call is built from.</p></div>
    </div>""") +
  sec("""    <h2>What an inspection can be shown</h2>
    <p>Drill and evacuation records with who was marked safe and when. The visitor log for any date or range. All of it append-only, so what is shown is what was recorded at the time, not a version of it.</p>""", tint=True) +
  sec('    <h2>Common questions</h2>\n' + faq_html(faqs)) +
  CTA +
  nextlinks("Read next", [
    ("/features/roll-call/", "Roll call", "Fire drills and evacuations on every warden's phone, offline."),
    ("/features/in-and-out/", "In &amp; out", "The live on-site count and the movement log."),
    ("/security-and-gdpr/", "Security and GDPR", "EU hosting, append-only records, erasure on request."),
  ]))
page("/for/nursing-homes-and-residential-care/",
     "CheckSteady for nursing homes and residential care — fire register, visitor book and roll call",
     "A fire register, visitor sign-in book and roll call for HIQA-registered nursing homes and residential care centres. Not a care record — EU hosted.",
     [HOME, ("/for/nursing-homes-and-residential-care/", "Nursing homes and residential care")], body, faqs)

# --------------------------------------------------------------------------
# /for/refuges-and-treatment-centres/
# --------------------------------------------------------------------------
faqs = [
 ("Does the app hold the refuge's address or location?",
  "No. A site is a name, with buildings and rooms under it — there is no postal-address field for a site, a building or a resident anywhere in the app."),
 ("Does anyone outside the service see the data?",
  "No. Each site's records live in their own separate database schema in the EU, the Sunday email carries counts in its body and, by default, the update attached as a Word document naming residents, and the nightly email to your ticked staff names the residents behind each of its four checks — all to the service's own accounts, and the app itself holds no analytics or tracking."),
 ("Can a resident's record be removed when they leave?",
  "A departed resident is archived, with their history kept for the retention period you set. If a service wants a record erased sooner, an administrator can erase it."),
 ("Is it a case-management or treatment-record system?",
  "No. It records presence and movement — who was seen, who came and went, who was marked safe at a drill. It holds no case notes, treatment records or support plans."),
]
body = (
  phead("Who it's for", "For refuges and residential treatment centres",
        "In a refuge or a residential treatment service, who is on site is a safety question, and who came to the door is a security one. The register is built so the answer is always current, and holds as little data as the job needs.") +
  sec("""    <h2>Who is on site, right now</h2>
    <p>A live count says how many people are on site at this moment, residents included. Residents are signed in and out like anyone else, an authorised absence carries a return date so a planned night away never reads as missing, and a fire drill runs by building with every warden's phone showing the same list.</p>
    <div class="pairs">
      <div><h3>Every arrival at the door</h3><p>Visitors, contractors and suppliers are signed in with their kind, name and company, and signed out on departure, so the roll call's list is everyone on site, not only residents.</p></div>
      <div><h3>Authorised leave, counted fairly</h3><p>In a residential treatment setting, planned leave and overnight passes are recorded as an authorised absence and excluded from the missed-night counts, so permitted time away is never counted as a miss.</p></div>
      <div><h3>Roll call at 3am</h3><p>Started from any staff phone, working offline, with the marked-safe list merging across every phone once the connection returns.</p></div>
      <div><h3>Children with a parent</h3><p>Households group a parent with their children, so a family stays together on the register, and children are marked on the roll call rather than left off it.</p></div>
    </div>""") +
  sec("""    <h2>Built for confidentiality</h2>
    <p>The register holds as little as the job needs, and what it holds is described here precisely, not summarised.</p>
    <div class="pairs">
      <div><h3>No postal address, anywhere</h3><p>The app has no postal-address field for a site, a building or a resident.</p></div>
      <div><h3>Names go to your own staff only</h3><p>The Sunday email carries counts and a link in its body, with the full update attached as a document naming residents, on by default — turn it off under Settings if your service wants counts only. The nightly email names each of its four checks in the body, to the staff you tick, and reaches nobody outside the service.</p></div>
      <div><h3>Identity documents, optional</h3><p>TRC or IRP can be recorded as printed if a service needs it. It is an optional field, left blank by any service that does not use it.</p></div>
      <div><h3>Logged, on a connected phone</h3><p>Opening a resident's record on a connected phone — the register sheet, the edit sheet, an export — is logged with who and when. A sheet read from a phone's offline copy is not.</p></div>
      <div><h3>One schema per site, in the EU</h3><p>Hosted in Frankfurt, encrypted in transit and at rest, with each site's records in their own separate database schema.</p></div>
      <div><h3>Erasure on request</h3><p>A resident's record can be erased on request, and the site's data is removed when the service leaves.</p></div>
    </div>
    <p>It was built with an accommodation centre's feedback and is offered here because the register is the same; we would want to hear from a refuge or a treatment service before claiming to know its day.</p>""", tint=True) +
  sec('    <h2>Common questions</h2>\n' + faq_html(faqs)) +
  CTA +
  nextlinks("Read next", [
    ("/security-and-gdpr/", "Security and GDPR", "EU hosting, per-site isolation, erasure on request."),
    ("/features/in-and-out/", "In &amp; out", "The live on-site count and the movement log."),
    ("/for/emergency-and-supported-accommodation/", "Emergency and supported accommodation", "The same register for family hubs and supported housing."),
  ]))
page("/for/refuges-and-treatment-centres/",
     "CheckSteady for refuges and residential treatment centres",
     "A daily register, visitor sign-in, live count and fire roll call for domestic violence refuges and residential treatment centres. No postal address. EU hosted.",
     [HOME, ("/for/refuges-and-treatment-centres/", "Refuges and treatment centres")], body, faqs)

# --------------------------------------------------------------------------
# /for/visitor-and-contractor-sign-in/
# --------------------------------------------------------------------------
faqs = [
 ("Do visitors need to install anything?",
  "No. Staff or reception sign them in on the Visitors tab — a visitor never opens the app themselves."),
 ("Can it print a badge or scan an ID?",
  "No. There is no badge printing and no ID scanning. A visitor is signed in with a kind, a name and an optional company, nothing more."),
 ("Does it work if the wifi drops?",
  "Daily check-ins and movements queue on the device and send once the connection returns. Signing a visitor or a contractor in or out needs a live connection, so keep the reception device on wifi. The roll call itself works offline: it keeps the last on-site visitor list on the phone, so a drill can still count them; marking a visitor safe needs a connection."),
 ("Is there a tablet mode for reception?",
  "Yes. Install it to a tablet's home screen and lock it there with the device's own Guided Access or Single App Mode."),
]
body = (
  phead("Who it's for", "A visitor and contractor sign-in book that does the fire roll call",
        "For any building with a reception — an office, a factory, a school, a community centre — that keeps a visitor book and needs a true list at the muster point.") +
  sec("""    <h2>Sign in, sign out, count</h2>
    <p>Reception, or whoever is on the door, opens the Visitors tab of the logged-in device. A visitor, a contractor, a supplier or a member of staff is signed in on arrival and signed out on departure, and the on-site count updates as it happens.</p>
    <div class="pairs">
      <div><h3>Anyone at the door</h3><p>Pick the kind — visitor, contractor, supplier or staff — then a name and an optional company. Nothing else is asked.</p></div>
      <div><h3>A staff list for one tap</h3><p>Paste your own site staff list — kitchen, cleaning, maintenance — one name per line, and each becomes a button on the Visitors tab. Signing a regular face in or out is one tap.</p></div>
      <div><h3>On the roll call while on site</h3><p>Everyone signed in stays on the roll call for as long as they are on site — the muster list is not only staff, it is everyone who was signed in.</p></div>
      <div><h3>The log for any range</h3><p>Who was in on a given day, or over a month, downloadable as a spreadsheet for an audit, a contractor review or your own records.</p></div>
    </div>""") +
  sec("""    <h2>The roll call</h2>
    <p>A drill or an evacuation starts from any warden's phone, and every phone on site shows the same list within seconds. A mark made with no signal queues on that phone and merges with everyone else's the moment it reconnects, so one warden at the far end of a car park does not hold up the count. Every drill is recorded and kept — who was marked safe, and when.</p>""", tint=True) +
  sec("""    <h2>When there are no residents</h2>
    <p>CheckSteady was built for residential sites, and it still carries a resident register. A building with no residents simply leaves it empty — the In &amp; out screen still shows it, with nobody on it — and works from the Visitors tab. Turn on Visitors and Evacuation under Settings &rarr; Features and turn nothing else on. Pricing is per site, per month, whatever is switched on.</p>""") +
  sec('    <h2>Common questions</h2>\n' + faq_html(faqs)) +
  CTA +
  nextlinks("Read next", [
    ("/features/in-and-out/", "In &amp; out", "The live on-site count and the movement log."),
    ("/features/roll-call/", "Roll call", "Drills and evacuations on every warden's phone, offline."),
    ("/pricing/", "Pricing", "Per site, per month, every feature included."),
  ]))
page("/for/visitor-and-contractor-sign-in/",
     "Visitor and contractor sign-in with a fire roll call — CheckSteady",
     "Sign visitors, contractors, suppliers and staff in and out, see who is on site, and run the fire roll call on every warden's phone. EU hosted.",
     [HOME, ("/for/visitor-and-contractor-sign-in/", "Visitor and contractor sign-in")], body, faqs)

# --------------------------------------------------------------------------
# /pricing/
# --------------------------------------------------------------------------
faqs = [
 ("How much does it cost?",
  "It is priced per site, per month, and we quote against the sites you actually run. Every feature is included at every price — there is no tier in which the audit trail, the roll call or the GDPR tooling costs extra."),
 ("Is there a charge per resident or per staff account?",
  "No. A busy winter should not change your bill, so it does not. Add as many residents and as many staff accounts as the site needs."),
 ("Is there a free trial?",
  "Yes — a free trial of a single site, with no card. You can start it with sample residents to explore, or empty and ready for your own list."),
 ("What happens to our data when a trial ends?",
  "Nothing is deleted. When a trial ends the site becomes read-only: you can still open it, read it, export it and erase records, but new check-ins cannot be recorded until it is activated. A trial lapsing must never cost a centre evidence it already recorded."),
 ("Do we need to install anything?",
  "No. It runs in a web browser on the phones, tablets and computers you already have, and installs to a home screen if you want it to. There is no app store, no server of yours and no hardware."),
 ("Can we get our data out?",
  "Always, and at any time. The register, movements, occupancy, drills and individual resident files all export as spreadsheets, and a full file for any resident is one click."),
]
body = (
  phead("Pricing", "Per site, per month. Everything included.",
        "No charge per resident, no charge per staff account, and no tier where the audit trail costs extra.") +
  sec("""    <h2>What is included</h2>
    <p>All of it. The daily welfare register, the In and out door log, roll call and evacuation records, buildings, rooms and vacancies, families, visitors and contractors, breach reports, the full report set, imports and exports, roles and permissions, and the GDPR tooling. Every feature, at every price.</p>
    <div class="pairs">
      <div><h3>Priced per site</h3><p>One figure per site per month. A site with forty residents and a site with two hundred cost the same, because your bill should not move with your occupancy.</p></div>
      <div><h3>No per-seat charge</h3><p>Give every staff member their own account. Attribution is the point of the record — charging per account would work against it.</p></div>
      <div><h3>No hardware</h3><p>It runs on the phones and tablets you already have, in a browser. Nothing to install, nothing to rack, nothing to replace in three years.</p></div>
      <div><h3>Your data, exportable</h3><p>Everything exports as a spreadsheet whenever you want it, in or out of contract.</p></div>
    </div>
    <h2>What we need to quote you</h2>
    <p>How many sites, roughly how many residents at each, and which parts you will use — some centres run the daily register and the door log, some only need the door log and the roll call. That is a ten-minute conversation, and we will send a figure in writing after it.</p>
    <p><a class="cta" href="mailto:aimee@tenzing.ie?subject=CheckSteady%20quote">Ask for a quote</a><a class="cta-secondary" href="/trial/">Start a free trial first</a></p>""") +
  sec("""    <h2>Try before the conversation</h2>
    <p>You do not have to talk to anyone to see it. Start a free trial of a single site, with sample residents to explore or empty for your own list, and have a look at the register, the roll call and the reports on your own phone. No card, and no obligation.</p>""", tint=True) +
  sec('    <h2>Common questions</h2>\n' + faq_html(faqs)) +
  nextlinks("Read next", [
    ("/trial/", "Start a free trial", "A single site, free, with no card. Sample data or empty."),
    ("/security-and-gdpr/", "Security and GDPR", "Where the data lives and who can reach it."),
    ("/features/daily-register/", "Daily register", "What your staff actually do each day."),
  ]))
page("/pricing/",
     "Pricing — CheckSteady",
     "Priced per site, per month, with every feature included: no charge per resident, no charge per staff account, and no tier where the audit trail costs extra.",
     [HOME, ("/pricing/", "Pricing")], body, faqs)

# --------------------------------------------------------------------------
# /security-and-gdpr/
# --------------------------------------------------------------------------
faqs = [
 ("Where is the data stored?",
  "In the European Union — Frankfurt — encrypted in transit and at rest. Nothing is sent to a third party: the application talks only to its own service, and there are no analytics, trackers or external fonts on the app."),
 ("Can an administrator edit or delete a check-in?",
  "No. Check-ins, movements, drills and notices are append-only and cannot be altered or removed by anyone, at any level, including us. A correction is recorded as a new entry alongside the original."),
 ("How is one centre kept separate from another?",
  "Each centre's records live in their own separate database schema, so isolation is structural rather than a filter somebody has to remember to apply. A mistake produces an error, not another centre's residents."),
 ("How do you handle a subject access request?",
  "One click produces a resident's complete file — their record, their check-ins, their movements and their history — ready to send."),
 ("How is data erased?",
  "Departed residents can be erased on a schedule, and the erasure itself is logged so you can evidence that it happened. Ending a contract is a separate, deliberate act with its own confirmation, never a side effect of a trial lapsing."),
 ("Who can see a resident's identity number?",
  "Only staff who open that resident's own record, and only supervisors and administrators can change it. Numbers never appear in a list, and every opening of a record is written to an access log."),
 ("What stops a shared tablet being left signed in?",
  "An idle lock, with the number of minutes set by the centre, and sessions that last a shift rather than a fortnight. Roles are enforced in the database itself, not only on the screen, so a refusal cannot be clicked past."),
]
body = (
  phead("Trust", "Security and GDPR",
        "What is held, who can reach it, how it is proved, and how it is erased.") +
  sec(f"""    <h2>The record is the product</h2>
    <p>A register is only worth keeping if it cannot be quietly rewritten afterwards. Check-ins, movements, drills and notices in CheckSteady are append-only: they cannot be edited or deleted by a staff member, a supervisor, an administrator, or by us. Every entry carries who recorded it and when, and nobody can act as somebody else.</p>
    <div class="pairs">
      <div><h3>Hosted in the EU</h3><p>Frankfurt, encrypted in transit and at rest. No third-party analytics, trackers or external fonts on the app.</p></div>
      <div><h3>Separated by construction</h3><p>Each centre has its own database schema. One centre cannot read, change, export or erase another's records, and the tests prove it.</p></div>
      <div><h3>Data minimisation</h3><p>Lists carry a name and what the screen needs. Dates of birth and identity numbers appear only on a record opened deliberately — and each opening on a connected phone is logged.</p></div>
      <div><h3>Roles in the database</h3><p>Staff record. Supervisors also manage the register. Administrators also manage accounts and run export and erasure. The rules are enforced below the screen.</p></div>
    </div>{analytics_note()}
    <h2>Subject access and erasure</h2>
    <p>A subject access request is one click: a resident's complete file, ready to send. Erasure runs on a schedule for departed residents and is itself logged, so you can evidence that it happened and when. An export asks for the reason it was taken, and that reason is kept with it.</p>
    <h2>Accounts and devices</h2>
    <p>Every staff member has their own account, because attribution is the point. Sessions last a shift rather than a fortnight, shared tablets lock after an idle period the centre sets, and sign-in supports a second factor. A password is never set for somebody by an administrator; a link is sent, and only its owner uses it.</p>""") +
  sec('    <h2>Common questions</h2>\n' + faq_html(faqs)) +
  CTA +
  nextlinks("Read next", [
    ("/for/ipas-accommodation/", "For IPAS accommodation", "How the record set fits an accommodation contract."),
    ("/features/daily-register/", "Daily register", "The record staff make, and why it cannot be edited."),
    ("/pricing/", "Pricing", "Per site, per month, every feature included."),
  ]))
page("/security-and-gdpr/",
     "Security and GDPR — CheckSteady",
     "Append-only records nobody can edit, each centre in its own database schema, EU hosting in Frankfurt, one-click subject access and logged, scheduled erasure.",
     [HOME, ("/security-and-gdpr/", "Security &amp; GDPR")], body, faqs)

faqs = [
 ("Do I need a card?",
  "No. There is no card and no automatic charge at the end. The trial simply stops accepting new entries until you decide to go ahead."),
 ("How long does the trial last?",
  "Seven days from the moment you open it. If you need longer to get colleagues in front of it, say so and we will extend it."),
 ("What happens on day eight?",
  "The site becomes read-only. Everything you recorded stays exactly where it is and you can still open it, read it, export it and erase records — you just cannot record new check-ins until the site is activated. A trial ending must never cost a centre evidence it already recorded."),
 ("Can I put real residents in it?",
  "Yes, and it becomes your live register if you go ahead. If you start with sample data and then decide to use it for real, clear the sample residents first from Admin so fabricated people never sit in a statutory record beside real ones."),
 ("Who else can see it?",
  "Nobody, until you invite them. Your centre's records live in their own separate database schema; no other centre's staff can reach them. You can invite colleagues from Admin once you are in."),
 ("What do I need to set up?",
  "Nothing to install. Open the link on a phone, a tablet or a computer and it works in the browser. If you want your own residents in it, import the spreadsheet you already keep and every line is previewed before anything is written."),
]

form = f"""    <div class="signup">
      <h2>Start your free trial</h2>
      <p class="sub">One site, seven days, no card. We will email you a link to open it.</p>
      <form method="post" action="{APP}/signup" id="trial-signup">
        <div class="field-row">
          <label for="su-name">Your name</label>
          <input id="su-name" name="full_name" type="text" required maxlength="120"
                 autocomplete="name" autocapitalize="words" spellcheck="false">
        </div>
        <div class="field-row">
          <label for="su-email">Work email
            <span class="note">We send the link here. Please use your organisation's address.</span></label>
          <input id="su-email" name="email" type="email" required maxlength="200"
                 autocomplete="email" autocapitalize="off" spellcheck="false">
        </div>
        <div class="field-row">
          <label for="su-centre">Centre or site name
            <span class="note">What your staff call it. You can change it later.</span></label>
          <input id="su-centre" name="centre_name" type="text" required maxlength="120"
                 autocomplete="organization" autocapitalize="words">
        </div>
        <fieldset class="choice">
          <legend class="note">How would you like to start?</legend>
          <label>
            <input type="radio" name="seed" value="sample" checked>
            <span><b>With sample residents</b>
            <span>About thirty fictional residents, rooms and a day of check-ins, so every screen has something in it. Clear them in one click when you are done looking.</span></span>
          </label>
          <label>
            <input type="radio" name="seed" value="empty">
            <span><b>Empty, for my own list</b>
            <span>A clean site. Import your own spreadsheet or add residents by hand. Nothing fictional ever touches the register.</span></span>
          </label>
        </fieldset>
        <button type="submit">Email me the link</button>
        <p class="smallprint">We will only email you about this trial. Your centre's records are held in the EU and are never shared. See <a href="/security-and-gdpr/">Security and GDPR</a>.</p>
      </form>
    </div>"""

left = """    <div>
      <h2>What you get</h2>
      <p>A working site of your own, not a guided demo. Everything is available: the daily register, the In and out door log, roll call, buildings and rooms, families, visitors and the rest. Start with sample residents and it is all switched on; start empty and turn on the parts you use under Settings → Features.</p>
      <ul>
        <li><strong>It opens on your phone.</strong> Nothing to install. Add it to the home screen if you want it there.</li>
        <li><strong>Sample data, if you want it.</strong> Thirty residents across rooms, with a day of check-ins already recorded and an attention list with something in it — so the screens look like a real morning rather than an empty box.</li>
        <li><strong>Or bring your own list.</strong> Import the spreadsheet you already keep; every line gets a verdict before anything is written.</li>
        <li><strong>Invite your colleagues.</strong> Add staff accounts from Admin and let a supervisor and a guard try it on their own phones.</li>
        <li><strong>Nothing is lost at the end.</strong> On day eight the site becomes read-only, not deleted. Read it, export it, erase it — it is yours.</li>
      </ul>
      <h2>What we do with your details</h2>
      <p>We email you a link to open the trial, and we may email you once to ask how you got on. That is it — no list, no third party, no card. Your centre's records live in their own database schema in the EU, and no other centre can reach them.</p>
    </div>"""

body = (
  phead("Free trial", "Try CheckSteady on a site of your own",
        "One site, seven days, no card. Explore it with sample residents, or start empty and import your own list.") +
  f'<section class="section">\n  <div class="wrap">\n    <div class="split">\n{left}\n{form}\n    </div>\n  </div>\n</section>' +
  sec('    <h2>Common questions</h2>\n' + faq_html(faqs), tint=True) +
  nextlinks("Read next", [
    ("/features/daily-register/", "Daily register", "What your staff do each day, and why it cannot be edited."),
    ("/security-and-gdpr/", "Security and GDPR", "Where the data lives and who can reach it."),
    ("/pricing/", "Pricing", "Per site, per month, every feature included."),
  ]))
page("/trial/",
     "Start a free trial — CheckSteady",
     "Try CheckSteady free on a single site for seven days. No card. Start with sample residents to explore, or empty and ready for your own list.",
     [HOME, ("/trial/", "Free trial")], body, faqs,
     page_script="/trial-submit.js")


print("site: wrote", len(WRITTEN), "pages")