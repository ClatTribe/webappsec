"""Scoring for TensorShield benchmark runs.

Matches actual scan findings against a hand-curated ground-truth list per
target and computes precision / recall / F1, plus side-by-side counts.

Matching is forgiving by design — DAST tools rarely tag findings with
the same CWE+endpoint string. A ground-truth entry counts as 'covered'
when any actual finding satisfies ONE of:
  1. matching CWE (CWE-89 == CWE-89) AND any title_keyword present, or
  2. matching endpoint substring AND any title_keyword present, or
  3. all title_keywords present in the finding's title/description.

A finding counts as a false positive when none of the ground-truth
entries match it under any of the above. This will over-count FPs in
practice (real DAST often surfaces genuine bugs the ground truth didn't
list — that's a strength, not a defect) — so we report both the
naive-FP and the conservative-FP variants.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, asdict, field
from pathlib import Path
from typing import Iterable


@dataclass
class GroundTruthVuln:
    id: str
    cwe: str | None = None
    title: str = ""
    endpoint: str | None = None
    method: str | None = None
    title_keywords: list[str] = field(default_factory=list)

    @staticmethod
    def from_dict(d: dict) -> "GroundTruthVuln":
        return GroundTruthVuln(
            id=d["id"],
            cwe=d.get("cwe"),
            title=d.get("title", ""),
            endpoint=d.get("endpoint"),
            method=d.get("method"),
            title_keywords=[k.lower() for k in d.get("title_keywords", [])],
        )


@dataclass
class Finding:
    """Subset of the wrapper's findings row this scorer needs."""
    id: str
    title: str
    severity: str | None = None
    cwe: str | None = None
    cve: str | None = None
    endpoint: str | None = None
    description_md: str | None = None

    @staticmethod
    def from_dict(d: dict) -> "Finding":
        return Finding(
            id=str(d["id"]),
            title=d.get("title") or "",
            severity=d.get("severity"),
            cwe=d.get("cwe"),
            cve=d.get("cve"),
            endpoint=d.get("endpoint"),
            description_md=d.get("description_md"),
        )

    def haystack(self) -> str:
        return " ".join(
            x for x in [self.title, self.description_md or "", self.endpoint or ""]
            if x
        ).lower()


def _norm_cwe(v: str | None) -> str | None:
    if not v:
        return None
    m = re.search(r"cwe[-_\s]*(\d+)", v.lower())
    return f"CWE-{m.group(1)}" if m else v


def matches(gt: GroundTruthVuln, f: Finding) -> bool:
    """Return True when the finding plausibly covers the ground-truth entry."""
    hay = f.haystack()
    gt_cwe = _norm_cwe(gt.cwe)
    f_cwe = _norm_cwe(f.cwe)

    # Path A: matching CWE + at least one keyword
    cwe_matches = gt_cwe is not None and f_cwe == gt_cwe
    keyword_hit = any(kw in hay for kw in gt.title_keywords) if gt.title_keywords else False

    if cwe_matches and keyword_hit:
        return True

    # Path B: matching endpoint substring + at least one keyword
    if gt.endpoint and gt.endpoint.lower() in hay and keyword_hit:
        return True

    # Path C: all keywords present (broader fallback)
    if gt.title_keywords and all(kw in hay for kw in gt.title_keywords):
        return True

    return False


@dataclass
class ScoreReport:
    target: str
    total_ground_truth: int
    findings_count: int
    true_positives: int           # ground-truth items covered by ≥1 finding
    false_negatives: int           # ground-truth items uncovered
    matched_findings: int          # findings that match ≥1 ground-truth item
    unmatched_findings: int         # findings that don't match any ground-truth item
    precision_strict: float        # tp / (tp + unmatched_findings)
    recall: float                  # tp / total_ground_truth
    f1_strict: float
    covered: list[str] = field(default_factory=list)
    uncovered: list[str] = field(default_factory=list)
    extras: list[str] = field(default_factory=list)


def score(target: str, ground_truth: Iterable[GroundTruthVuln], findings: Iterable[Finding]) -> ScoreReport:
    gt_list = list(ground_truth)
    f_list = list(findings)

    covered: list[str] = []
    uncovered: list[str] = []
    matched_findings: set[str] = set()

    for gt in gt_list:
        hits = [f for f in f_list if matches(gt, f)]
        if hits:
            covered.append(gt.id)
            for h in hits:
                matched_findings.add(h.id)
        else:
            uncovered.append(gt.id)

    extras = [f.title or f.id for f in f_list if f.id not in matched_findings]

    tp = len(covered)
    fn = len(uncovered)
    unmatched = len(extras)

    precision = tp / (tp + unmatched) if (tp + unmatched) > 0 else 0.0
    recall = tp / len(gt_list) if gt_list else 0.0
    f1 = (2 * precision * recall / (precision + recall)) if (precision + recall) > 0 else 0.0

    return ScoreReport(
        target=target,
        total_ground_truth=len(gt_list),
        findings_count=len(f_list),
        true_positives=tp,
        false_negatives=fn,
        matched_findings=len(matched_findings),
        unmatched_findings=unmatched,
        precision_strict=round(precision, 3),
        recall=round(recall, 3),
        f1_strict=round(f1, 3),
        covered=covered,
        uncovered=uncovered,
        extras=extras[:20],  # cap for readability
    )


def load_ground_truth(path: Path) -> list[GroundTruthVuln]:
    with path.open() as f:
        data = json.load(f)
    return [GroundTruthVuln.from_dict(v) for v in data["vulns"]]


def load_findings(path: Path) -> list[Finding]:
    """Loads findings exported as JSON (an array of objects, or {findings: [...]})."""
    with path.open() as f:
        data = json.load(f)
    if isinstance(data, dict) and "findings" in data:
        data = data["findings"]
    return [Finding.from_dict(d) for d in data]


def to_markdown(reports: list[ScoreReport]) -> str:
    lines = ["# TensorShield benchmark results", ""]
    lines.append("| Target | Ground truth | Findings | TP | FN | Extras | Precision | Recall | F1 |")
    lines.append("|---|---:|---:|---:|---:|---:|---:|---:|---:|")
    for r in reports:
        lines.append(
            f"| {r.target} | {r.total_ground_truth} | {r.findings_count} | "
            f"{r.true_positives} | {r.false_negatives} | {r.unmatched_findings} | "
            f"{r.precision_strict:.0%} | {r.recall:.0%} | {r.f1_strict:.0%} |"
        )
    lines.append("")
    for r in reports:
        lines.append(f"## {r.target}")
        lines.append("")
        if r.covered:
            lines.append("**Covered (true positives)**")
            lines.append("")
            for c in r.covered:
                lines.append(f"- {c}")
            lines.append("")
        if r.uncovered:
            lines.append("**Uncovered (false negatives)**")
            lines.append("")
            for c in r.uncovered:
                lines.append(f"- {c}")
            lines.append("")
        if r.extras:
            lines.append(f"**Extras (findings not in ground truth — {r.unmatched_findings} total, first 20)**")
            lines.append("")
            for e in r.extras:
                lines.append(f"- {e}")
            lines.append("")
    return "\n".join(lines)


def summary_json(reports: list[ScoreReport]) -> str:
    return json.dumps([asdict(r) for r in reports], indent=2)
