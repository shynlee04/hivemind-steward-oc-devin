#!/usr/bin/env python3
"""Scrub machine/account identifiers out of captured fixtures, and gate trees.

--fix   : apply scripts/private-scrub-rules.txt replacements under test/.
          The rules file holds real identifiers and is dev-repo only
          (.publicignore) — this file ships publicly with generic shapes only.
--check : scan a tree for leak shapes, exit 1 with findings. CI runs this on
          the exported public tree so a capture can never leak paths, personal
          mailboxes, embedded binaries, or credential-shaped strings.
"""
import pathlib
import re
import sys

RULES_FILE = pathlib.Path(__file__).parent / "private-scrub-rules.txt"

# Capture-group checks: the extracted segment is compared, so this file's own
# pattern source never matches itself (the text after /Users/ is "(").
HOME_PATH = re.compile(r"/(?:Users|home)/([A-Za-z0-9_-]+)")
HOME_ALLOW = {"test", "you"}
TOOL_DIR = re.compile(r"~/\.(local|ssh|agents|gnupg|aws|kube|docker)\b")
PERSONAL_MAIL = re.compile(r"[\w.+-]+@(gmail|yahoo|outlook|hotmail|icloud|proton|aol)\.")
BLOB_B64 = re.compile(r"[A-Za-z0-9+/]{50000,}={0,2}")
TOKEN = re.compile(r"sk-[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{20,}|gho_[a-zA-Z0-9]{20,}|xox[bpoas]-|-----BEGIN [A-Z ]*PRIVATE KEY")

# docs/ is vendored upstream material — its path examples are the upstream's.
SKIP_DIRS = {".git", "node_modules", "docs"}
SKIP_FILES = {"bun.lock"}


def load_rules():
    rules = []
    for line in RULES_FILE.read_text().splitlines():
        if not line or line.startswith("#"):
            continue
        src, _, dst = line.partition("\t")
        if src:
            rules.append((src, dst))
    return rules


def iter_files(root):
    for p in sorted(root.rglob("*")):
        if not p.is_file():
            continue
        if SKIP_DIRS & set(p.parts):
            continue
        if p.name in SKIP_FILES:
            continue
        yield p


def fix(root):
    if not RULES_FILE.exists():
        print(f"no scrub rules at {RULES_FILE} — dev-repo only file", file=sys.stderr)
        return 2
    rules = load_rules()
    changed = 0
    for p in iter_files(root / "test"):
        try:
            s = p.read_text()
        except (UnicodeDecodeError, ValueError):
            continue
        t = s
        for src, dst in rules:
            t = t.replace(src, dst)
        if t != s:
            p.write_text(t)
            changed += 1
            print(f"scrubbed {p.relative_to(root)}")
    print(f"{changed} file(s) rewritten")
    return 0


def check(root):
    findings = 0
    for p in iter_files(root):
        try:
            s = p.read_text()
        except (UnicodeDecodeError, ValueError):
            continue
        found = set()
        for m in HOME_PATH.finditer(s):
            if m.group(1) not in HOME_ALLOW:
                found.add(f"line {s.count(chr(10), 0, m.start()) + 1}: home path /{m.group(0)}")
        for pat in (TOOL_DIR, PERSONAL_MAIL, BLOB_B64, TOKEN):
            for m in pat.finditer(s):
                found.add(f"line {s.count(chr(10), 0, m.start()) + 1}: {pat.pattern[:40]}")
                break
        for f in sorted(found):
            print(f"LEAK {p.relative_to(root)}:{f}")
            findings += 1
    print(f"{findings} finding(s)")
    return 1 if findings else 0


def main():
    argv = sys.argv[1:]
    mode = argv[0] if argv else "--fix"
    root = pathlib.Path(argv[1] if len(argv) > 1 else ".").resolve()
    if mode == "--fix":
        return fix(root)
    if mode == "--check":
        return check(root)
    print(__doc__.strip())
    return 2


if __name__ == "__main__":
    sys.exit(main())
