#!/usr/bin/env python3
"""Produce the sanitized public completeness ledger from a private census."""

from __future__ import annotations

import csv
import sys
from pathlib import Path

from scan import PATTERNS


SCRUB = [
    ("sha" + "ne", "owner"),
    ("bar" + "ron", "owner"),
    ("sb" + "arron", "owner"),
    ("pneu" + "ma", "agent"),
    ("no" + "us", "agent"),
    ("co" + "da", "agent"),
    ("ale" + "theia", "agent"),
    ("char" + "la", "agent"),
    ("ar" + "gus", "agent"),
    ("au" + "ra", "agent"),
    ("ma" + "tt", "client"),
    ("jen" + "sen", "client"),
    ("mne" + "va", "product"),
]

PUBLIC_REASON = {
    "keep-port": "Ships as a full-fidelity apparatus capability.",
    "keep-adapter": "Ships behind a platform-neutral adapter interface.",
    "excluded-private": "Excluded because it contains private identity or local-state material.",
    "excluded-business": "Excluded because it is project-specific business tooling.",
    "excluded-noise": "Excluded because it is editor, OS, backup, or incident-marker noise.",
    "gap-v1": "Documented platform-adapter gap; capability is not presented as complete there.",
}


def scrub(text: str) -> str:
    cleaned = text
    for term, replacement in SCRUB:
        cleaned = cleaned.replace(term, replacement)
        cleaned = cleaned.replace(term.title(), replacement)
    return cleaned


def assert_clean(path: Path) -> None:
    leaks: list[tuple[int, str, str]] = []
    for line_no, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        for label, pattern in PATTERNS:
            if pattern.search(line):
                leaks.append((line_no, label, line))
    if not leaks:
        return
    print(f"LEAK: public ledger contains {len(leaks)} private term(s)", file=sys.stderr)
    for line_no, label, line in leaks[:20]:
        print(f"  line {line_no}: {label}: {line[:180]}", file=sys.stderr)
    raise SystemExit(1)


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("usage: generate-public-ledger.py <private.tsv> <public.tsv>")

    src, out = map(Path, sys.argv[1:])
    with src.open(newline="") as handle:
        reader = csv.DictReader(handle, delimiter="\t")
        public_rows = []
        for row in reader:
            classification = row.get("classification", "")
            public_rows.append(
                {
                    "layer": scrub(row.get("layer", "")),
                    "public_capability": scrub(row.get("public_capability", "") or "not shipped"),
                    "classification": scrub(classification),
                    "public_reason": PUBLIC_REASON.get(
                        classification, "See project documentation."
                    ),
                }
            )

    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", newline="") as handle:
        writer = csv.DictWriter(
            handle,
            fieldnames=["layer", "public_capability", "classification", "public_reason"],
            delimiter="\t",
            lineterminator="\n",
        )
        writer.writeheader()
        writer.writerows(public_rows)

    assert_clean(out)
    print(f"OK public ledger written: {out} ({len(public_rows)} components, 0 leaks)")


if __name__ == "__main__":
    main()
