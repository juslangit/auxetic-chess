#!/usr/bin/env python3
"""Builds docs/index.html: the whole record of Auxetic Chess in one file.

Luqman asked on 2026-09-15 for every game except Referee For Fun (which already had one) to
get the same kind of record Referee For Fun has: one HTML file holding the idea, the planning,
every decision and method, the session logs, and the screenshots with their explanations,
kept in the repo and rebuilt whenever the game changes. So this is a generator rather than a
hand-written page: the project notes stay the source of truth, and the page is rebuilt from them.

    python3 tools/docs/build_docs.py
    python3 tools/docs/build_docs.py --artifact <file.html>   # also a copy to publish

The published copy lives at ARTIFACT below. Publish the --artifact copy to that URL (the
Artifact tool's `url`) so the link never changes; that copy drops the <html>/<head>/<body>
wrapper, which the publisher adds itself.

Reads:
    ~/.claude/knowledge/projects/auxetic-chess/*.md and log/*.md   (override: KNOWLEDGE=...)
    the screenshots named in GALLERIES
    the header comments of the files named in CATALOGUES
    git log

Writes docs/index.html, fully self-contained: every screenshot is embedded as a JPEG. No
Python packages beyond the standard library; `sips` (built into macOS) shrinks the images.

To add something: add its screenshots to a gallery in GALLERIES and run this again. Notes
written into the knowledge base appear on their own. Everything above the "engine" line is
this game's; everything below it is the same in every game's copy.
"""

import base64
import datetime
import html
import os
import pathlib
import re
import subprocess
import tempfile

PROJECT = pathlib.Path(__file__).resolve().parents[2]
SLUG = "auxetic-chess"
KNOWLEDGE = pathlib.Path(os.environ.get(
    "KNOWLEDGE", pathlib.Path.home() / ".claude/knowledge/projects" / SLUG))
OUT = PROJECT / "docs" / "index.html"

NAME = "Auxetic Chess"
ARTIFACT = ""   # the private link the --artifact copy is published to

# The picture at the top: (path from the project root, alt text).
HERO = ("", "")


# --- the galleries ---------------------------------------------------------------------
#
# Each gallery: (id, title, intro, layout, [(path, caption), ...]). Paths are from the project
# root. layout is "wide" for landscape pictures (two to a row) or "tall" for phone portraits
# (four to a row). The date under each picture is the file's own, so an old screenshot says
# it is old.

GALLERIES = [
]


# --- how the game gets made ----------------------------------------------------------------

PIPELINE_LEDE = ""

# (step, what happens, where it lives)
PIPELINE = [
]

# (tool, what it does here)
TOOLS = [
]

# What proves the game works. (id, title, intro, [glob from the project root, ...]); each
# matching file is listed with the comment at its top.
CATALOGUES = [
]


def counts():
    """Six (label, value) pairs for the cover, each counted from a real file."""
    return [
        ("Commits", git("rev-list", "--count", "HEAD").strip()),
        ("Decisions", str(decisions())),
    ]


# The knowledge base, in reading order. (id, title, file, fold level): sections at the fold
# level fold away, so a long decision log can still be skimmed by its headings.
NOTES = [
    ("idea", "Idea", "01-idea.md", None),
    ("planning", "Planning", "02-planning.md", 2),
    ("milestones", "Milestones", "03-milestones.md", 2),
    ("decisions", "Decisions", "06-decisions.md", 2),
    ("methods", "Methods", "04-methods.md", 2),
    ("relations", "Relations", "05-relations.md", None),
    ("references", "References", "07-references.md", 2),
]

# The look of the page, taken from the game's own colours. Light palette first, then the same
# tokens redefined for dark. --accent is links and markers, --flag the label on the cover.
FONTS = "https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600;700&family=IBM+Plex+Mono:wght@500&family=IBM+Plex+Sans:ital,wght@0,400;0,500;0,600;1,400&display=swap"
LIGHT = """--ground: #F3F6FA; --surface: #FFFFFF; --ink: #14202E; --muted: #56667A; --line: #D6DFE9;
  --accent: #2C68AC; --accent-soft: #E3ECF7; --flag: #FFC22E; --flag-ink: #1A1400; --done: #2E7D4F;
  --display: "Barlow Condensed", "Arial Narrow", "Helvetica Neue", Arial, sans-serif;
  --body: "IBM Plex Sans", "Helvetica Neue", Arial, sans-serif; --mono: "IBM Plex Mono", ui-monospace, Menlo, monospace;
  --heading-case: uppercase;"""
DARK = """--ground: #0D1621; --surface: #142131; --ink: #E7EDF4; --muted: #95A5B8; --line: #253649;
  --accent: #6AA6E8; --accent-soft: #18304A; --done: #6CC592;"""


# ============================== engine: the same in every game ==============================

# --- markdown ------------------------------------------------------------------------------

def inline(text):
    """The inline half of markdown, on already-escaped text."""
    codes = []

    def keep(m):
        codes.append(m.group(1))
        return f"\x00{len(codes) - 1}\x00"

    text = re.sub(r"`([^`]+)`", keep, text)
    text = re.sub(r"\[([^\]]+)\]\(([^)\s]+)\)",
                  lambda m: f'<a href="{m.group(2)}">{m.group(1)}</a>'
                  if m.group(2).startswith(("http://", "https://")) else m.group(1), text)
    text = re.sub(r"(?<![\w&\"])(https?://[^\s<)]+)", r'<a href="\1">\1</a>', text)
    text = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", text)
    text = re.sub(r"~~(.+?)~~", r"<del>\1</del>", text)
    text = re.sub(r"(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?!\w)", r"<em>\1</em>", text)
    text = re.sub(r"(?<![\w])_(?!\s)(.+?)(?<!\s)_(?![\w])", r"<em>\1</em>", text)
    return re.sub(r"\x00(\d+)\x00", lambda m: f"<code>{codes[int(m.group(1))]}</code>", text)


def slug(text, taken):
    base = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:60] or "section"
    name, n = base, 2
    while name in taken:
        name, n = f"{base}-{n}", n + 1
    taken.add(name)
    return name


def markdown(source, prefix, taken, fold=None, drop_title=True):
    """Converts one notes file. Headings at `fold` open a <details> that holds everything
    until the next heading at that level or above."""
    source = re.sub(r"\A---\n.*?\n---\n", "", source, flags=re.S)
    lines = source.split("\n")
    out, para, lists, open_folds = [], [], [], 0
    i = 0

    def flush_para():
        if para:
            out.append("<p>" + inline(html.escape(" ".join(para), quote=False)) + "</p>")
            para.clear()

    def close_lists(to=0):
        while len(lists) > to:
            out.append(f"</{lists.pop()[0]}>")

    while i < len(lines):
        line = lines[i]
        stripped = line.strip()

        if stripped.startswith("```"):
            flush_para(); close_lists()
            block = []
            i += 1
            while i < len(lines) and not lines[i].strip().startswith("```"):
                block.append(lines[i])
                i += 1
            out.append("<pre><code>" + html.escape("\n".join(block)) + "</code></pre>")
            i += 1
            continue

        heading = re.match(r"^(#{1,4})\s+(.*)$", line)
        if heading:
            flush_para(); close_lists()
            level = len(heading.group(1))
            title = heading.group(2).strip()
            if level == 1 and drop_title:
                i += 1
                continue
            if fold is not None and level <= fold:
                while open_folds:
                    out.append("</div></details>")
                    open_folds -= 1
            anchor = slug(f"{prefix}-{title}", taken)
            if fold is not None and level == fold:
                out.append(f'<details class="fold" id="{anchor}"><summary><span>'
                           f"{inline(html.escape(title, quote=False))}</span></summary><div>")
                open_folds += 1
            else:
                tag = min(level + 1, 5)
                out.append(f'<h{tag} id="{anchor}">{inline(html.escape(title, quote=False))}</h{tag}>')
            i += 1
            continue

        if stripped.startswith("|") and i + 1 < len(lines) and re.match(r"^\s*\|[\s:|-]+\|\s*$", lines[i + 1]):
            flush_para(); close_lists()
            def cells(row):
                return [c.strip() for c in row.strip().strip("|").split("|")]
            head = cells(line)
            i += 2
            rows = []
            while i < len(lines) and lines[i].strip().startswith("|"):
                rows.append(cells(lines[i]))
                i += 1
            out.append('<div class="table"><table><thead><tr>' + "".join(
                f"<th>{inline(html.escape(c, quote=False))}</th>" for c in head) + "</tr></thead><tbody>")
            for row in rows:
                out.append("<tr>" + "".join(
                    f"<td>{inline(html.escape(c, quote=False))}</td>" for c in row) + "</tr>")
            out.append("</tbody></table></div>")
            continue

        item = re.match(r"^(\s*)([-*]|\d+\.)\s+(\[[ xX]\]\s+)?(.*)$", line)
        if item:
            flush_para()
            depth = len(item.group(1)) // 2
            kind = "ol" if item.group(2)[0].isdigit() else "ul"
            while len(lists) > depth + 1:
                out.append(f"</{lists.pop()[0]}>")
            if len(lists) == depth + 1 and lists[-1][0] != kind:
                out.append(f"</{lists.pop()[0]}>")
            if len(lists) < depth + 1:
                out.append(f"<{kind}>")
                lists.append((kind, depth))
            box = item.group(3)
            mark = ""
            if box:
                mark = '<span class="box done">done</span> ' if "x" in box.lower() else '<span class="box">to do</span> '
            text = item.group(4)
            # A continuation line indented under the item belongs to it.
            while i + 1 < len(lines) and lines[i + 1].startswith(" " * (len(item.group(1)) + 2)) \
                    and lines[i + 1].strip() and not lines[i + 1].strip().startswith("|") \
                    and not re.match(r"^\s*([-*]|\d+\.)\s+", lines[i + 1]):
                i += 1
                text += " " + lines[i].strip()
            out.append(f"<li>{mark}{inline(html.escape(text, quote=False))}</li>")
            i += 1
            continue

        if stripped.startswith(">"):
            flush_para(); close_lists()
            quote = []
            while i < len(lines) and lines[i].strip().startswith(">"):
                quote.append(lines[i].strip()[1:].strip())
                i += 1
            out.append("<blockquote>" + inline(html.escape(" ".join(quote), quote=False)) + "</blockquote>")
            continue

        if re.match(r"^\s*(---|\*\*\*)\s*$", line):
            flush_para(); close_lists()
            i += 1
            continue

        if not stripped:
            flush_para()
            if not (i + 1 < len(lines) and re.match(r"^\s+([-*]|\d+\.)\s+", lines[i + 1])):
                close_lists()
            i += 1
            continue

        if lists and line.startswith("  ") and not stripped.startswith("|"):
            # Loose text under a list item.
            out[-1] = out[-1].replace("</li>", " " + inline(html.escape(stripped, quote=False)) + "</li>")
            i += 1
            continue

        close_lists()
        para.append(stripped)
        i += 1

    flush_para(); close_lists()
    while open_folds:
        out.append("</div></details>")
        open_folds -= 1
    return "\n".join(out)


# --- pictures ----------------------------------------------------------------------------

IMAGE_SIZE = 880        # longest side, in pixels
IMAGE_QUALITY = 62
_cache = pathlib.Path(tempfile.gettempdir()) / f"{SLUG}-docs-images"
_cache.mkdir(exist_ok=True)
missing = []


def picture(name):
    """(data URI, date, width, height) for a screenshot, or Nones when it is not there."""
    path = PROJECT / name
    if not name or not path.exists():
        missing.append(name or "(no hero set)")
        return None, None, 0, 0
    stamp = int(path.stat().st_mtime)
    jpeg = _cache / f"{path.stem}-{stamp}.jpg"
    if not jpeg.exists():
        subprocess.run(["sips", "-s", "format", "jpeg", "-s", "formatOptions", str(IMAGE_QUALITY),
                        "-Z", str(IMAGE_SIZE), str(path), "--out", str(jpeg)],
                       check=True, capture_output=True)
    size = subprocess.run(["sips", "-g", "pixelWidth", "-g", "pixelHeight", str(jpeg)],
                          capture_output=True, text=True).stdout
    width = int(re.search(r"pixelWidth: (\d+)", size).group(1))
    height = int(re.search(r"pixelHeight: (\d+)", size).group(1))
    data = base64.b64encode(jpeg.read_bytes()).decode()
    return (f"data:image/jpeg;base64,{data}", datetime.date.fromtimestamp(stamp).isoformat(),
            width, height)


def figure(name, caption):
    uri, date, width, height = picture(name)
    if uri is None:
        return (f'<figure class="shot missing"><div class="gap">Screenshot not taken yet: '
                f"<code>{html.escape(name)}</code></div><figcaption><span>{html.escape(caption)}</span>"
                f"</figcaption></figure>")
    return (f'<figure class="shot"><img src="{uri}" alt="{html.escape(caption)}" loading="lazy" '
            f'width="{width}" height="{height}"><figcaption>'
            f'<span>{inline(html.escape(caption, quote=False))}</span><span class="date">{date}</span></figcaption></figure>')


def grid(figures, layout):
    odd = " odd" if layout == "wide" and len(figures) % 2 else ""
    return f'<div class="shots {layout}{odd}">{"".join(figures)}</div>'


# --- the facts that can be counted ---------------------------------------------------------

def git(*args):
    return subprocess.run(["git", *args], cwd=PROJECT, capture_output=True, text=True).stdout


def decisions():
    path = KNOWLEDGE / "06-decisions.md"
    return len(re.findall(r"^## ", path.read_text(), re.M)) if path.exists() else 0


def files(pattern):
    return sorted(p for p in PROJECT.glob(pattern) if p.is_file())


def header_comment(path):
    """The comment a file opens with: `//` or `#` lines, or a /* */ block, read as prose."""
    text = path.read_text(errors="replace")
    lines = text.split("\n")
    while lines and (lines[0].startswith("#!") or not lines[0].strip()
                     or lines[0].strip() in ('"use strict";', "'use strict';")
                     or re.match(r"^(extends|class_name|@tool)\b", lines[0])):
        lines.pop(0)
    found = []
    if lines and lines[0].lstrip().startswith("/*"):
        for line in lines:
            part = re.sub(r"^\s*(/\*+|\*/|\*)\s?", "", line)
            part = part.replace("*/", "").strip()
            if part:
                found.append(part)
            elif found:
                break
            if "*/" in line:
                break
        return " ".join(found)
    for line in lines:
        m = re.match(r"^\s*(//+|#+)\s?(.*)$", line)
        if not m:
            break
        if not m.group(2).strip():
            if found:
                break
            continue
        found.append(m.group(2).strip())
    return " ".join(found)


def catalogue(patterns):
    rows = []
    for pattern in patterns:
        for path in files(pattern):
            rows.append(f"<tr><td><code>{html.escape(str(path.relative_to(PROJECT)))}</code></td>"
                        f"<td>{inline(html.escape(header_comment(path) or '—', quote=False))}</td></tr>")
    return '<div class="table"><table><thead><tr><th>File</th><th>What it does</th></tr></thead><tbody>' \
        + "".join(rows) + "</tbody></table></div>"


def history():
    rows = []
    for line in git("log", "--date=short", "--pretty=format:%h\t%ad\t%s").split("\n"):
        if not line:
            continue
        sha, date, subject = line.split("\t", 2)
        merge = "merge" if subject.lower().startswith("merge") else ""
        rows.append(f'<tr class="{merge}"><td><code>{sha}</code></td><td class="nowrap">{date}</td>'
                    f"<td>{html.escape(subject)}</td></tr>")
    return '<div class="table"><table><thead><tr><th>Commit</th><th>Date</th><th>Change</th></tr></thead><tbody>' \
        + "".join(rows) + "</tbody></table></div>"


# --- the page ----------------------------------------------------------------------------------

def page():
    taken = set()
    overview_path = KNOWLEDGE / "00-overview.md"
    overview = overview_path.read_text() if overview_path.exists() else ""
    overview = re.sub(r"\A---\n.*?\n---\n", "", overview, flags=re.S)
    # The thesis is the overview's first paragraph after its title.
    thesis = re.search(r"^# .*?\n\n(.+?)(?=\n\n)", overview, re.S | re.M)
    thesis = " ".join(l.lstrip("> ").strip() for l in thesis.group(1).split("\n")) if thesis else ""
    built = datetime.date.today().isoformat()
    branch = git("branch", "--show-current").strip()

    toc, body = [], []

    # Cover
    stats = "".join(f'<div class="stat"><b>{html.escape(v)}</b><span>{html.escape(k)}</span></div>'
                    for k, v in counts())
    uri, _, width, height = picture(HERO[0])
    hero = (f'<img class="hero" src="{uri}" alt="{html.escape(HERO[1])}" '
            f'width="{width}" height="{height}">') if uri else ""
    body.append(f'''
<header class="cover" id="top">
  <p class="eyebrow"><b>{html.escape(NAME)}</b><span>Project record · built {built}{f" from {html.escape(branch)}" if branch else ""}</span></p>
  <h1>{html.escape(NAME)}</h1>
  <p class="thesis">{inline(html.escape(thesis, quote=False))}</p>
  <div class="stats">{stats}</div>
  {hero}
</header>''')

    # Overview
    rest = re.sub(r"^# .*?\n\n.+?\n\n", "", overview, count=1, flags=re.S | re.M)
    toc.append(("overview", "Overview", []))
    body.append(f'''
<section class="chapter notes" id="overview">
  <p class="kicker">00-overview.md</p>
  <h2>Overview</h2>
  <div class="prose">{markdown(rest, "overview", taken, None)}</div>
</section>''')

    # Pipeline
    if PIPELINE or TOOLS:
        toc.append(("pipeline", "Pipeline", []))
        steps = "".join(f'<li><b>{html.escape(a)}</b><span>{html.escape(b)}</span><code>{html.escape(c)}</code></li>'
                        for a, b, c in PIPELINE)
        tools = "".join(f"<tr><td><strong>{html.escape(a)}</strong></td><td>{inline(html.escape(b, quote=False))}</td></tr>"
                        for a, b in TOOLS)
        body.append(f'''
<section class="chapter" id="pipeline">
  <p class="kicker">How the game gets made</p>
  <h2>Pipeline</h2>
  <p class="lede">{html.escape(PIPELINE_LEDE)}</p>
  <ol class="pipeline">{steps}</ol>
  <h3 id="tools">Tools</h3>
  <div class="table"><table><tbody>{tools}</tbody></table></div>
</section>''')

    # Screens
    if GALLERIES:
        subs, parts = [], []
        for gid, title, intro, layout, shots in GALLERIES:
            subs.append((gid, title))
            parts.append(f'<section class="gallery" id="{gid}"><h3>{html.escape(title)}</h3>'
                         f'<p class="note">{html.escape(intro)}</p>'
                         f'{grid([figure(n, c) for n, c in shots], layout)}</section>')
        toc.append(("screens", "Screens", subs))
        body.append(f'''
<section class="chapter" id="screens">
  <p class="kicker">What the player sees</p>
  <h2>Screens</h2>
  <p class="lede">Screenshots from the game. Each carries the date it was taken: older ones show the game as it was then, and are kept as a record rather than replaced.</p>
  {"".join(parts)}
</section>''')

    # The notes
    for nid, title, name, fold in NOTES:
        path = KNOWLEDGE / name
        if not path.exists():
            continue
        text = path.read_text()
        converted = markdown(text, nid, taken, fold)
        heads = re.findall(r"^## (.+)$", re.sub(r"```.*?```", "", text, flags=re.S), re.M)
        folds = ' <button class="unfold" type="button" data-for="%s">Open all</button>' % nid if fold else ""
        toc.append((nid, title, []))
        body.append(f'''
<section class="chapter notes" id="{nid}">
  <p class="kicker">{html.escape(name)} · {len(heads)} sections{folds}</p>
  <h2>{html.escape(title)}</h2>
  <div class="prose">{converted}</div>
</section>''')

    # Logs
    log_dir = KNOWLEDGE / "log"
    logs = sorted((p for p in log_dir.glob("*.md") if not p.name.startswith("_")), reverse=True) \
        if log_dir.exists() else []
    entries = "".join(
        f'<details class="fold" id="log-{p.stem}"><summary><span>{p.stem}</span></summary>'
        f'<div>{markdown(p.read_text(), "log-" + p.stem, taken, None)}</div></details>'
        for p in logs)
    toc.append(("log", "Session log", []))
    body.append(f'''
<section class="chapter notes" id="log">
  <p class="kicker">log/ · {len(logs)} sessions <button class="unfold" type="button" data-for="log">Open all</button></p>
  <h2>Session log</h2>
  <div class="prose">{entries}</div>
</section>''')

    # Catalogues
    if CATALOGUES:
        folds = "".join(f'<details class="fold" id="{cid}"><summary><span>{html.escape(title)}</span></summary>'
                        f'<div><p class="note">{html.escape(intro)}</p>{catalogue(patterns)}</div></details>'
                        for cid, title, intro, patterns in CATALOGUES)
        toc.append(("checks", "Tests and tools", []))
        body.append(f'''
<section class="chapter" id="checks">
  <p class="kicker">What proves it works, from each file's own header comment</p>
  <h2>Tests and tools</h2>
  {folds}
</section>''')

    toc.append(("history", "Git history", []))
    body.append(f'''
<section class="chapter" id="history">
  <p class="kicker">git log{f" on {html.escape(branch)}" if branch else ""}, newest first</p>
  <h2>Git history</h2>
  <details class="fold"><summary><span>Every commit</span></summary><div>{history()}</div></details>
</section>''')

    nav = []
    for tid, title, subs in toc:
        inner = "".join(f'<li><a href="#{sid}">{html.escape(st)}</a></li>' for sid, st in subs)
        nav.append(f'<li><a href="#{tid}">{html.escape(title)}</a>{f"<ul>{inner}</ul>" if inner else ""}</li>')

    return (TEMPLATE.replace("{{TITLE}}", html.escape(f"{NAME} Record"))
            .replace("{{FONTS}}", FONTS).replace("{{LIGHT}}", LIGHT).replace("{{DARK}}", DARK)
            .replace("{{NAV}}", "".join(nav)).replace("{{BODY}}", "".join(body)))


TEMPLATE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>{{TITLE}}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="{{FONTS}}">
<style>
:root { {{LIGHT}} color-scheme: light; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { {{DARK}} color-scheme: dark; } }
:root[data-theme="dark"] { {{DARK}} color-scheme: dark; }
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
@media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } }
body { margin: 0; background: var(--ground); color: var(--ink); font: 400 16px/1.6 var(--body); padding-inline: 20px; }
a { color: var(--accent); }
a:focus-visible, button:focus-visible, summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.layout { max-width: 1320px; margin: 0 auto; display: grid; grid-template-columns: 220px minmax(0, 1fr); gap: 48px; padding-block: 32px 96px; }
nav.toc { position: sticky; top: calc(env(safe-area-inset-top, 0px) + 20px); align-self: start; max-height: calc(100vh - 40px); overflow-y: auto; font-size: 14px; }
nav.toc > ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
nav.toc > ul > li > a { font: 700 16px/1.3 var(--display); letter-spacing: .06em; text-transform: var(--heading-case); color: var(--ink); text-decoration: none; }
nav.toc ul ul { list-style: none; margin: 2px 0 8px; padding: 0 0 0 10px; border-left: 1px solid var(--line); display: grid; gap: 1px; }
nav.toc ul ul a { color: var(--muted); text-decoration: none; }
nav.toc a:hover { color: var(--accent); }
main { display: grid; gap: 72px; min-width: 0; }
.eyebrow { display: inline-flex; flex-wrap: wrap; gap: 10px; align-items: center; margin: 0; font: 700 14px/1 var(--display); letter-spacing: .12em; text-transform: uppercase; }
.eyebrow b { background: var(--flag); color: var(--flag-ink); padding: 5px 9px; }
.eyebrow span { color: var(--muted); }
h1 { font: 700 clamp(44px, 7vw, 84px)/.92 var(--display); text-transform: var(--heading-case); margin: 14px 0 12px; text-wrap: balance; }
.thesis { max-width: 68ch; margin: 0; font-size: 18px; }
.stats { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 0; margin: 28px 0; border-block: 2px solid var(--ink); }
.stat { padding: 12px 14px; display: grid; gap: 2px; border-left: 1px solid var(--line); }
.stat:first-child { border-left: 0; padding-left: 0; }
.stat b { font: 700 34px/1 var(--display); font-variant-numeric: tabular-nums; }
.stat span { font-size: 12px; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
.hero { width: 100%; max-width: 100%; height: auto; max-height: 640px; object-fit: contain; display: block; background: var(--surface); }
.chapter { display: grid; gap: 14px; scroll-margin-top: 16px; }
.kicker { margin: 0; font-size: 13px; color: var(--muted); display: flex; flex-wrap: wrap; gap: 12px; align-items: center; }
h2 { font: 700 48px/1 var(--display); text-transform: var(--heading-case); margin: 0 0 6px; padding-bottom: 10px; border-bottom: 2px solid var(--ink); }
h3 { font: 700 30px/1.05 var(--display); text-transform: var(--heading-case); margin: 24px 0 4px; scroll-margin-top: 16px; }
h4 { font: 700 21px/1.1 var(--display); text-transform: var(--heading-case); letter-spacing: .02em; margin: 18px 0 8px; }
h5 { font: 600 16px/1.3 var(--body); margin: 18px 0 4px; }
.lede, .note { max-width: 70ch; margin: 0; color: var(--muted); }
.gallery { scroll-margin-top: 16px; display: grid; gap: 8px; }
.shots { display: grid; gap: 18px; margin-top: 10px; align-items: start; }
.shots.wide { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.shots.tall { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.shots.odd > .shot:first-child { grid-column: 1 / -1; }
.shots.odd > .shot:first-child img { max-height: 560px; object-fit: contain; }
.shot { margin: 0; display: grid; gap: 6px; align-content: start; }
.shot img { display: block; width: 100%; max-width: 100%; height: auto; background: var(--line); border: 1px solid var(--line); }
.shot figcaption { font-size: 14px; line-height: 1.4; display: grid; grid-template-columns: 1fr auto; gap: 10px; align-items: baseline; }
.tall .shot figcaption { grid-template-columns: 1fr; gap: 2px; }
.date { font: 500 12px/1 var(--mono); color: var(--muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
.missing .gap { aspect-ratio: 16 / 9; display: grid; place-items: center; border: 1px dashed var(--line); color: var(--muted); font-size: 14px; padding: 16px; text-align: center; }
.pipeline { list-style: none; counter-reset: step; margin: 10px 0 0; padding: 0; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0; border-top: 1px solid var(--line); border-left: 1px solid var(--line); }
.pipeline li { counter-increment: step; padding: 14px 16px 16px; display: grid; gap: 4px; align-content: start; border-right: 1px solid var(--line); border-bottom: 1px solid var(--line); background: var(--surface); }
.pipeline b { font: 700 20px/1 var(--display); text-transform: var(--heading-case); }
.pipeline b::before { content: counter(step) "  "; color: var(--accent); font-family: var(--mono); font-size: 13px; font-weight: 500; }
.pipeline span { font-size: 14.5px; }
.pipeline code { font-size: 12px; color: var(--muted); justify-self: start; }
.prose { max-width: 82ch; display: grid; gap: 0; }
.prose p, .prose ul, .prose ol, .prose blockquote, .prose pre, .prose .table { margin: 0 0 12px; }
.prose ul, .prose ol { padding-left: 22px; }
.prose li { margin: 3px 0; }
.prose blockquote { border-left: 3px solid var(--flag); padding: 4px 0 4px 14px; color: var(--muted); }
code { font: 500 .86em var(--mono); background: var(--accent-soft); padding: 1px 4px; overflow-wrap: anywhere; }
pre { background: var(--surface); border: 1px solid var(--line); padding: 12px 14px; overflow-x: auto; }
pre code { background: none; padding: 0; overflow-wrap: normal; white-space: pre; }
.table { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: 14px; }
th, td { text-align: left; vertical-align: top; padding: 7px 10px; border-bottom: 1px solid var(--line); }
th { font: 700 14px/1.2 var(--display); letter-spacing: .08em; text-transform: uppercase; color: var(--muted); border-bottom: 2px solid var(--ink); }
.chapter > .table td:first-child { width: 220px; }
tr.merge td { color: var(--muted); }
.nowrap { white-space: nowrap; font-variant-numeric: tabular-nums; }
del { color: var(--muted); }
.box { font: 500 11px/1 var(--mono); padding: 2px 5px; border: 1px solid var(--line); color: var(--muted); vertical-align: 1px; }
.box.done { color: var(--done); border-color: var(--done); }
details.fold { border-bottom: 1px solid var(--line); scroll-margin-top: 16px; }
details.fold > summary { cursor: pointer; list-style: none; padding: 10px 0; display: flex; gap: 10px; align-items: baseline; font: 600 16px/1.35 var(--body); }
details.fold > summary::-webkit-details-marker { display: none; }
details.fold > summary::before { content: "+"; font: 500 14px var(--mono); color: var(--accent); width: 12px; flex: none; }
details.fold[open] > summary::before { content: "\\2212"; }
details.fold > div { padding: 2px 0 18px 22px; }
.unfold { font: 600 12px/1 var(--body); color: var(--accent); background: var(--surface); border: 1px solid var(--line); padding: 5px 9px; cursor: pointer; }
.unfold:hover { border-color: var(--accent); }
@media (max-width: 980px) {
  .layout { grid-template-columns: 1fr; gap: 24px; }
  nav.toc { position: static; max-height: none; border-bottom: 2px solid var(--ink); padding-bottom: 14px; }
  nav.toc > ul { grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); }
  nav.toc ul ul { display: none; }
  .stats { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .stat:nth-child(4) { border-left: 0; padding-left: 0; }
  .pipeline { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .shots.tall { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}
@media (max-width: 560px) {
  .shots.wide { grid-template-columns: 1fr; }
  .shots.tall { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .pipeline { grid-template-columns: 1fr; }
  .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .stat:nth-child(4) { border-left: 1px solid var(--line); padding-left: 14px; }
  .stat:nth-child(odd) { border-left: 0; padding-left: 0; }
  h2 { font-size: 38px; }
  .shot figcaption { grid-template-columns: 1fr; gap: 2px; }
}
</style>
</head>
<body>
<div class="layout">
  <nav class="toc" aria-label="Contents"><ul>{{NAV}}</ul></nav>
  <main>{{BODY}}</main>
</div>
<script>
document.querySelectorAll(".unfold").forEach(function (button) {
  button.addEventListener("click", function () {
    var section = document.getElementById(button.dataset.for);
    var folds = section.querySelectorAll("details.fold");
    var opening = button.textContent === "Open all";
    folds.forEach(function (d) { d.open = opening; });
    button.textContent = opening ? "Close all" : "Open all";
  });
});
// A link to something inside a closed fold opens the fold.
function openTarget() {
  var target = location.hash && document.getElementById(decodeURIComponent(location.hash.slice(1)));
  for (var node = target; node; node = node.parentElement) {
    if (node.tagName === "DETAILS") node.open = true;
  }
  if (target) target.scrollIntoView();
}
window.addEventListener("hashchange", openTarget);
openTarget();
</script>
</body>
</html>
"""


def publishable(document):
    document = re.sub(r"^<!doctype html>\s*<html[^>]*>\s*<head>\s*", "", document, flags=re.I)
    document = re.sub(r'<meta charset="utf-8">\s*<meta name="viewport"[^>]*>\s*', "", document)
    return document.replace("</head>\n<body>\n", "", 1).replace("</body>\n</html>\n", "")


if __name__ == "__main__":
    import sys
    OUT.parent.mkdir(exist_ok=True)
    document = page()
    OUT.write_text(document)
    if "--artifact" in sys.argv:
        target = pathlib.Path(sys.argv[sys.argv.index("--artifact") + 1])
        target.write_text(publishable(document))
        print(f"wrote {target} for publishing")
    size = OUT.stat().st_size / 1024 / 1024
    print(f"wrote {OUT.relative_to(PROJECT)}  ({size:.1f} MB)")
    if missing:
        print("screenshots not found (shown as gaps):", ", ".join(missing))
