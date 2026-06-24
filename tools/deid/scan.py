#!/usr/bin/env python3
"""Leak scanner for become-kit public artifacts."""

from __future__ import annotations

import argparse
import os
import re
from pathlib import Path


DEFAULT_EXCLUDES = {
    ".git",
    "node_modules",
    ".venv",
    "__pycache__",
    ".pytest_cache",
    "dist",
    "build",
}

PRIVATE_TERMS = [
    "sha" + "ne",
    "bar" + "ron",
    "pneu" + "ma",
    "no" + "us",
    "co" + "da",
    "ale" + "theia",
    "char" + "la",
    "ar" + "gus",
    "au" + "ra",
    "ma" + "tt",
    "jen" + "sen",
    "sb" + "arron",
]

BUSINESS_TERMS = [
    "up" + "work",
    "client" + "_register",
    "meta" + "_proposals",
    "proposal" + " tooling",
    "saf" + "ari-crm",
    "tra" + "vel-crm",
    "trav" + "elcrm",
    "tapestry" + "ofafrica",
]

# Routable IP literals are private infrastructure. Allow only loopback,
# RFC1918/link-local/documentation ranges that are safe to ship as examples.
_IP_ALLOW_PREFIXES = (
    "127.", "0.0.0.0", "255.", "10.", "192.168.", "169.254.",
    "172.16.", "172.17.", "172.18.", "172.19.", "172.20.",
    "172.21.", "172.22.", "172.23.", "172.24.", "172.25.",
    "172.26.", "172.27.", "172.28.", "172.29.", "172.30.", "172.31.",
    "192.0.2.", "198.51.100.", "203.0.113.",  # RFC5737 doc ranges
)


def _is_private_infra_ip(ip: str) -> bool:
    return not ip.startswith(_IP_ALLOW_PREFIXES)

TOKEN_LEFT = r"(?<![A-Za-z0-9])"
TOKEN_RIGHT = r"(?![A-Za-z0-9])"

_IP_LITERAL = re.compile(r"(?<![\d.])((?:\d{1,3}\.){3}\d{1,3})(?![\d.])")

PATTERNS = [
    ("private identity term", re.compile(TOKEN_LEFT + r"(" + "|".join(PRIVATE_TERMS) + r")" + TOKEN_RIGHT, re.I)),
    ("private business term", re.compile(TOKEN_LEFT + r"(" + "|".join(BUSINESS_TERMS) + r")" + TOKEN_RIGHT, re.I)),
    (
        "hardcoded home path",
        re.compile(
            "/" + "Users" + r"/[A-Za-z0-9_.-]+"
            r"|/home/[A-Za-z0-9_.-]+"
            r"|~/" + r"(?:\.claude\b|Documents/Codex\b)"
        ),
    ),
    (
        "private knowledge path",
        re.compile(
            r"(?:~|\$HOME|/" + "Users" + r"/[^/\s]+|/home/[^/\s]+)/" + "vault" + r"\b"
            r"|\b" + "sacred" + r"[_-]",
            re.I,
        ),
    ),
    ("secret-looking assignment", re.compile(r"(?i)\b(api[_-]?key|secret|token|password)\b\s*[:=]")),
    (
        "raw database fixture",
        re.compile(
            r"(?i)\bcopy\s+\w+\s+from stdin"
            r"|\binsert\s+into\b[\s\S]{0,400}?\bvalues\s*\(\s*(?:'|[0-9])"
        ),
    ),
]

BINARY_EXTENSIONS = {
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".ico",
    ".pdf",
    ".sqlite",
    ".db",
}


def iter_files(root: Path) -> list[Path]:
    files: list[Path] = []
    for path in root.rglob("*"):
        rel_parts = set(path.relative_to(root).parts)
        if rel_parts & DEFAULT_EXCLUDES:
            continue
        if path.is_file() and path.suffix.lower() not in BINARY_EXTENSIONS:
            files.append(path)
    return sorted(files)


def scan_file(path: Path) -> list[tuple[str, int, str]]:
    try:
        text = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        text = path.read_text(encoding="utf-8", errors="ignore")
    findings: list[tuple[str, int, str]] = []
    for line_no, line in enumerate(text.splitlines(), start=1):
        for label, pattern in PATTERNS:
            if pattern.search(line):
                findings.append((label, line_no, line.strip()[:180]))
        for ip in _IP_LITERAL.findall(line):
            if _is_private_infra_ip(ip):
                findings.append(("private infrastructure IP", line_no, line.strip()[:180]))
    return findings


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Scan become-kit for private leaks")
    parser.add_argument("paths", nargs="*", default=["."], help="Files or directories to scan")
    args = parser.parse_args(argv)

    all_findings: list[tuple[Path, str, int, str]] = []
    for raw_path in args.paths:
        root = Path(raw_path).resolve()
        candidates = iter_files(root) if root.is_dir() else [root]
        for path in candidates:
            for label, line_no, snippet in scan_file(path):
                all_findings.append((path, label, line_no, snippet))

    if all_findings:
        print(f"LEAK scan failed: {len(all_findings)} finding(s)", file=os.sys.stderr)
        for path, label, line_no, snippet in all_findings[:200]:
            print(f"{path}:{line_no}: {label}: {snippet}", file=os.sys.stderr)
        if len(all_findings) > 200:
            print(f"... {len(all_findings) - 200} more finding(s)", file=os.sys.stderr)
        return 1

    print("OK leak scan passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
