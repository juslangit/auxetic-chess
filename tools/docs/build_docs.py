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
import hashlib
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
ARTIFACT = "https://claude.ai/artifact/ULbs2WDBVUtg9MGaNZe9Bw"   # the private link the --artifact copy is published to

# The picture at the top: (path from the project root, alt text).
HERO = ("docs/shots/bloom-half.png",
        "The Auxetic Chess board half-open: sixteen square tiles hinged at their corners, each "
        "carrying a two-by-two patch of the checkerboard and the pieces standing on it.")


# --- the galleries ---------------------------------------------------------------------
#
# Each gallery: (id, title, intro, layout, [(path, caption), ...]). Paths are from the project
# root. layout is "wide" for landscape pictures (two to a row) or "tall" for phone portraits
# (four to a row). The date under each picture is the file's own, so an old screenshot says
# it is old.

GALLERIES = [
    ("screens-fold", "The board and its fold", "The rotating-squares mechanism the game is named after. Tile spacing comes from the hinge constraint d = a·√2·cos(45° + θ), not from an animation curve.", "wide", [
        ("docs/shots/bloom-open.png", "Fully bloomed, as a new game begins: the tiles meet only at their hinge pins, and the board covers twice its closed area."),
        ("docs/shots/bloom-half.png", "Halfway closed: each tile turns the opposite way to its neighbours, so the gaps shrink on both axes at once."),
    ]),
    ("screens-twist", "One move, frame by frame", "The twist is the whole game: after every move all sixteen 2×2 blocks turn a quarter and carry what stands on them. The first five frames are 1. e4 in two-player mode, with the turn held still for each picture.", "wide", [
        ("docs/shots/frame-1-select.png", "White to move: the e2 pawn is selected, and the dots show its two squares straight ahead."),
        ("docs/shots/frame-2-played.png", "1. e4 is played. The board has not turned yet."),
        ("docs/shots/frame-3-turning.png", "The blocks start to turn, and every tile takes its pieces with it, pawns included."),
        ("docs/shots/frame-4-turning.png", "Past halfway, the new e4 pawn is sweeping round its block towards f4."),
        ("docs/shots/frame-5-landed.png", "Landed: the pawn is on f4, the a1 rook has been carried to a2, and every light and dark square has swapped."),
        ("test/shots/twist-mid.png", "From the browser suite: a slowed-down turn at the start position, caught mid-flight to prove the capture really lands inside the animation."),
        ("test/shots/twist-done.png", "The same test once it settles. It turns only the paint, so the pieces sit on their starting squares while light and dark have swapped."),
    ]),
    ("screens-playing", "Playing a game", "Two players on one keyboard, or the computer at four strengths. Each side has three stops, and a stop holds the board still for your move and the reply.", "wide", [
        ("docs/shots/midgame-selected.png", "Six moves into a two-player game: the knight on c4 is selected with its moves dotted, and both sides' stops are marked in the move list."),
        ("docs/shots/stop-armed.png", "Stop turning pressed before White's first move: the button fills amber and promises the board will not turn."),
        ("docs/shots/stop-computer-reply.png", "After 1. Nf3 with a stop, the club computer answers d6 on an unturned board. White has 2 of 3 stops left."),
        ("test/shots/stop-running.png", "From the browser suite: White stopped the board for e4, so the button is dashed and reads Board stopped while Black replies."),
        ("docs/shots/promotion.png", "A pawn steps to e8 and the Promote to box offers a queen, rook, bishop or knight."),
        ("docs/shots/hotseat-quick-mate.png", "A short two-player game with the casual engine playing both sides. It ends in Qxc3# on move five."),
        ("test/shots/checkmate.png", "Checkmate from the browser suite: the board stays shut and dimmed under the card, so the mating rook on a8 is still visible."),
        ("docs/shots/stalemate-bloomed.png", "A stalemate. There is no card for a draw: the board blooms back open around the three pieces left."),
    ]),
    ("screens-leaderboard", "Start screen and leaderboard", "Added 2026-09-15 (M9). Every game now starts here: a username, a computer level and a colour, or Two players with no name. Each computer level keeps its own table of wins, saved in the browser. The single Luqman win in these pictures is the one the browser test suite records.", "wide", [
        ("docs/shots/start-screen.png", "The page on first load: the start screen over the bloomed-open board, and an empty Strong leaderboard."),
        ("docs/shots/ranked-win.png", "A ranked checkmate against Casual. The card adds the player's total and rank, and the side panel confirms the win was saved."),
        ("docs/shots/leaderboard-window.png", "Leaderboard from the side panel: one tab per level, opening on the level being played, with your own row in amber."),
    ]),
    ("screens-phone-start", "The start screen on a phone", "Captured at 390 px wide. The form and the leaderboard stack into one column.", "tall", [
        ("docs/shots/phone-start.png", "The name from last time is filled in, and picking Casual shows the Casual table."),
    ]),
    ("screens-phone", "On a phone", "Captured at 390 px wide. The board sits on top and the side panel stacks underneath.", "tall", [
        ("docs/shots/phone-opening.png", "The opening position, with the status, Stop turning and the controls under the board."),
        ("docs/shots/phone-twist-mid.png", "The quarter turn after 1. e4, caught partway."),
        ("docs/shots/phone-panel.png", "Scrolled down: White is in check, the move list marks three stops, and White has one left."),
        ("docs/shots/phone-checkmate.png", "The checkmate card fits inside the board at phone width."),
    ]),
    ("screens-spin", "The table spin, removed", "The first reading of the request on 2026-09-12 turned the whole table instead of the blocks. It was removed the next day (D-005, M2). These pictures are kept as the record.", "wide", [
        ("test/shots/spin-mid.png", "The whole board mid-spin on its corner, with the Fold slider and Spin table checkbox that were later removed."),
        ("test/shots/spin-quarter.png", "The spin settled a quarter round: the board is side-on and the armies face each other left and right."),
    ]),
]


# --- how the game gets made ----------------------------------------------------------------

PIPELINE_LEDE = ("Auxetic Chess started as a 21-second video of a 3D-printed board and is built in plain "
                 "HTML, CSS and JavaScript with no dependencies. Each layer is proved by numbers before "
                 "the next goes on top: the geometry before any drawing, perft before the search, engine "
                 "suites before the browser, and a browser suite that clicks the real page before a merge.")

# (step, what happens, where it lives)
PIPELINE = [
    ("The object", "Luqman sends a video of Ruven Bals's folding board. Frames are pulled with a small Swift and AVFoundation script to identify it.", "07-references.md"),
    ("The fork", "A printable model or a playable game? He chooses the game.", "06-decisions.md · D-001"),
    ("The geometry", "The hinge constraint is derived, then checked in plain Node before any rendering code exists.", "test/geom_check.js"),
    ("Rules engine", "A 0x88 board with move generation, SAN and FEN. The twist and the stops run inside make and unmake, so the search plays the variant.", "js/chess.js"),
    ("Perft", "Move generation is counted against 26 published reference numbers, and the plain rules are re-checked with the twist off.", "test/perft.js"),
    ("Search", "Negamax with alpha-beta, quiescence and killer moves, four strengths, a price on stops, and piece tables averaged over each block's four squares.", "js/ai.js · test/ai_test.js"),
    ("Variant suites", "Node tests for the twist and for stop turning: the permutation, exact undo, legality against a twist-free clone, the stop rules.", "test/twist_test.js · test/stop_test.js"),
    ("Board and pieces", "Canvas renderer for the fold and the turn, with the tile and the six piece types baked once into offscreen sprites.", "js/board.js · js/pieces.js"),
    ("Game wiring", "Input, the computer's turn, two-player mode, undo, the stop button and the checkmate card.", "js/main.js · index.html · style.css"),
    ("Browser suites", "A hand-rolled DevTools Protocol client drives headless Chrome and clicks the real page: castling, the twist, hotseat, undo, stops.", "test/cdp.js · test/run.sh"),
    ("Screenshots", "The browser suites save pictures of the states they check. The pictures on this page come from them and from a docs pass.", "test/shots/ · docs/shots/"),
    ("Branch and merge", "Work goes on a feature branch, is committed and pushed to GitHub, and is merged into main with --no-ff.", "git · github.com/juslangit/auxetic-chess"),
]

# (tool, what it does here)
TOOLS = [
    ("Canvas 2D", "Draws the board, the fold, the turning blocks and the pieces. Offscreen canvases hold the baked sprites."),
    ("WebAudio", "Synthesises the move, capture, fold and game-over sounds at runtime, so the game ships no audio files."),
    ("Node 26", "Runs the geometry, perft, search, twist and stop suites. Its built-in `WebSocket` also drives Chrome for the browser tests."),
    ("Google Chrome (headless)", "Runs the browser suites and takes the screenshots."),
    ("test/cdp.js", "A small Chrome DevTools Protocol client with no npm packages: it opens a tab with the cache off, evaluates JavaScript, clicks squares and captures screenshots."),
    ("python3 -m http.server", "Serves the folder for the browser suites (port 8765 in `test/run.sh`). The game itself also runs straight from `file://`."),
    ("Swift + AVFoundation", "Pulled frames out of the original video when `ffmpeg` was not installed."),
    ("git and GitHub", "Feature branches merged into `main`, pushed to https://github.com/juslangit/auxetic-chess (public since 2026-09-15)."),
    ("tools/docs/build_docs.py", "Builds this page from the knowledge-base notes, the screenshots and the git log. `sips` shrinks the pictures."),
]

# What proves the game works. (id, title, intro, [glob from the project root, ...]); each
# matching file is listed with the comment at its top.
CATALOGUES = [
    ("checks-tests", "Test files", "Everything in test/. `test/run.sh` runs the Node suites first, then serves the folder and runs the browser suites in order. A dash means the file opens with code rather than a comment.", ["test/run.sh", "test/*.js"]),
    ("checks-source", "Game source", "The six scripts index.html loads, in the order they load.", ["js/chess.js", "js/ai.js", "js/pieces.js", "js/leaderboard.js", "js/board.js", "js/main.js"]),
]


def counts():
    """Six (label, value) pairs for the cover, each counted from a real file."""
    source = files("js/*.js")
    lines = sum(len(p.read_text().splitlines()) for p in source)
    tests = files("test/*.js") + files("test/run.sh")
    notes = KNOWLEDGE / "06-decisions.md"
    numbered = len(re.findall(r"^## D-\d+", notes.read_text(), re.M)) if notes.exists() else 0
    plan = KNOWLEDGE / "03-milestones.md"
    milestones = len(re.findall(r"^## M\d+", plan.read_text(), re.M)) if plan.exists() else 0
    return [
        ("Game scripts", str(len(source))),
        ("Lines of JavaScript", f"{lines:,}"),
        ("Test files", str(len(tests))),
        ("Milestones", str(milestones)),
        ("Decisions", str(numbered)),
        ("Commits", git("rev-list", "--count", "HEAD").strip()),
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
# From style.css: ground #0c0e12, panels #14171d, ink #e9e6df, dim ink #9aa1ad, amber #ffc44a on
# #2a1d00. The light palette is the board's cream tile (#f7f4ee) with the dark square as ink and
# the amber deepened until it reads as text. The game's type is the system sans with a heavy
# uppercase CHECKMATE headline, so: Inter Tight for display, Inter for body, JetBrains Mono.
FONTS = "https://fonts.googleapis.com/css2?family=Inter+Tight:wght@700;800&family=Inter:ital,wght@0,400;0,500;0,600;1,400&family=JetBrains+Mono:wght@500&display=swap"
LIGHT = """--ground: #F3EFE6; --surface: #FFFCF6; --ink: #1B1F26; --muted: #5B6069; --line: #DDD6C8;
  --accent: #8A5700; --accent-soft: #F5E6C2; --flag: #FFC44A; --flag-ink: #2A1D00; --done: #2A7148;
  --display: "Inter Tight", "Helvetica Neue", Arial, sans-serif;
  --body: "Inter", -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --mono: "JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace;
  --heading-case: uppercase;"""
DARK = """--ground: #0C0E12; --surface: #14171D; --ink: #E9E6DF; --muted: #9AA1AD; --line: #272C35;
  --accent: #FFC44A; --accent-soft: #2B2415; --done: #6CC592;"""


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
    text = re.sub(r"(?<![\w&\"])(https?://[^\s<)*]*[^\s<)*.,;:!?])", r'<a href="\1">\1</a>', text)
    text = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", text)
    text = re.sub(r"~~(.+?)~~", r"<del>\1</del>", text)
    text = re.sub(r"(?<!\*)\*(?![\s*])(.+?)(?<![\s*])\*(?!\*)", r"<em>\1</em>", text)
    text = re.sub(r"(?<![\w_])_(?![\s_])(.+?)(?<![\s_])_(?![\w_])", r"<em>\1</em>", text)
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
    source = re.sub(r"<!--.*?-->", "", source, flags=re.S)
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
            lang = stripped[3:].strip().lower()
            block = []
            i += 1
            while i < len(lines) and not lines[i].strip().startswith("```"):
                block.append(lines[i])
                i += 1
            if lang == "mermaid":
                out.append('<pre class="mermaid">' + html.escape("\n".join(block)) + "</pre>")
            else:
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
            if not item.group(4).strip():
                i += 1   # an empty template bullet
                continue
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
    key = hashlib.sha1(str(path).encode()).hexdigest()[:8]
    jpeg = _cache / f"{path.stem}-{key}-{stamp}.jpg"
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
    if not path.exists():
        return 0
    text = path.read_text()
    numbered = re.findall(r"^## D-\d+", text, re.M)
    return len(numbered) if numbered else len(re.findall(r"^## ", text, re.M))


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
  <p class="kicker">log/ · {len(logs)} session{"" if len(logs) == 1 else "s"} <button class="unfold" type="button" data-for="log">Open all</button></p>
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
pre.mermaid { background: #FFFFFF; text-align: center; }
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
  .stat { border-left: 1px solid var(--line); padding-left: 14px; }
  .stat:nth-child(3n+1) { border-left: 0; padding-left: 0; }
  .pipeline { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .shots.tall { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}
@media (max-width: 560px) {
  .shots.wide { grid-template-columns: 1fr; }
  .shots.tall { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .pipeline { grid-template-columns: 1fr; }
  .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .stat:nth-child(even) { border-left: 1px solid var(--line); padding-left: 14px; }
  .stat:nth-child(odd) { border-left: 0; padding-left: 0; }
  .chapter > .table td:first-child { width: 36%; }
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
<!--mermaid-->
<script src="https://cdnjs.cloudflare.com/ajax/libs/mermaid/10.9.1/mermaid.min.js"></script>
<script>if (window.mermaid) mermaid.initialize({ startOnLoad: true, theme: "neutral" });</script>
<!--/mermaid-->
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
    document = re.sub(r"<!--mermaid-->.*?<!--/mermaid-->\n", "", document, flags=re.S)
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
