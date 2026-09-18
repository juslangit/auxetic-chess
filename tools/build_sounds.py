#!/usr/bin/env python3
"""Rebuild js/sounds.js from the Kenney CC0 packs.

The nine sounds are embedded in the page as base64 data URIs instead of being
kept as .ogg files, because Chrome refuses to fetch audio over file:// and
opening index.html straight from the folder has to keep working.

Get the packs first (the `sfx` CLI downloads them to /tmp/audio/packs):

    sfx pack interface-sounds
    sfx pack impact-sounds

then run this from the repo root:

    python3 tools/build_sounds.py

Both packs are CC0 -- public domain, no attribution required, safe to sell.
"""

import base64
import os
import sys

PACKS = os.environ.get("SFX_PACKS", "/tmp/audio/packs")

# What each sound is for, and which file plays it. Swap a filename here and
# re-run to change a sound; the packs hold 230 of them to choose from.
PICKS = {
    "select":  "interface-sounds/Audio/click_002.ogg",           # lifting a piece
    "move":    "impact-sounds/Audio/impactWood_medium_000.ogg",  # setting it down
    "capture": "impact-sounds/Audio/impactWood_heavy_000.ogg",   # taking a piece
    "twist":   "interface-sounds/Audio/switch_003.ogg",          # the blocks turning
    "fold":    "interface-sounds/Audio/maximize_006.ogg",        # blooming open
    "close":   "interface-sounds/Audio/minimize_006.ogg",        # folding into play
    "check":   "impact-sounds/Audio/impactBell_heavy_000.ogg",   # check
    "end":     "interface-sounds/Audio/confirmation_002.ogg",    # game over
    "illegal": "interface-sounds/Audio/error_003.ogg",           # a move that is not
}

HEADER = """/* The sound bank, carried in the page.

   Nine sounds from Kenney's CC0 packs -- "Interface Sounds" and "Impact Sounds"
   -- public domain, no attribution required, safe to sell. They are embedded as
   base64 rather than kept as files for one reason: Chrome will not fetch an
   .ogg over file://, and opening index.html straight from the folder has to
   keep working (the same constraint that rules out a Web Worker, D-004).

   Phaser's sound manager loads these in js/board.js and plays them through
   WebAudio, so several can overlap and each has its own volume and rate.

   Regenerate with tools/build_sounds.py after changing the picks below. */

const SOUND_BANK = {
"""


def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out = os.path.join(root, "js", "sounds.js")

    missing = [p for p in PICKS.values() if not os.path.exists(os.path.join(PACKS, p))]
    if missing:
        print("Missing sound files under %s:" % PACKS, file=sys.stderr)
        for m in missing:
            print("  " + m, file=sys.stderr)
        print("\nRun:  sfx pack interface-sounds && sfx pack impact-sounds", file=sys.stderr)
        return 1

    parts = [HEADER]
    for key, rel in PICKS.items():
        with open(os.path.join(PACKS, rel), "rb") as f:
            data = base64.b64encode(f.read()).decode()
        parts.append("  /* %s */\n  %s: 'data:audio/ogg;base64,%s',\n"
                     % (os.path.basename(rel), key, data))
    parts.append("};\n")

    with open(out, "w") as f:
        f.write("".join(parts))
    print("wrote %s  (%.0f KB, %d sounds)" % (out, os.path.getsize(out) / 1024, len(PICKS)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
