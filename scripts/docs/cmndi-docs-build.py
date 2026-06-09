#!/usr/bin/env python3
# CMNDI-DOCS-MANDATE-001 — single-file HTML builder.
# Reads docs/cmndi/0[1-6]-*.md, emits docs/cmndi/index.html with interactive TOC.
# Zero external deps. CMNDI dark-SOC styling, no CDN, no fonts fetched.

from __future__ import annotations

import html
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SRC_DIR = REPO_ROOT / "docs" / "cmndi"
OUT_HTML = SRC_DIR / "index.html"

# All known doc slots, in render order. Whether each is REQUIRED vs
# OPTIONAL depends on the repo tier per CMNDI-DOCS-MANDATE-001 §2:
#  - Tier C (customer-facing): 01..05 required; 06 required ONLY if
#    the repo is private. Public-Apache repos (lodestone) MUST NOT
#    publish 06 per the §2 carve-out.
#  - Tier I (internal): 02 + 03 required; 01/04/05/06 optional.
# The builder adapts to whatever source files are PRESENT — missing
# files are skipped silently, present-but-unexpected names are
# ignored. This keeps one script usable across tiers without per-repo
# forks. The minimum viable build is 02+03 (Tier I floor); anything
# less prints a clear error.
ALL_DOCS = [
    ("01-executive-1pager.md", "Executive 1-Pager", "exec"),
    ("02-technical-spec.md", "Technical Specification", "tech"),
    ("03-end-user-guide.md", "Operator Guide", "user"),
    ("04-brochure.md", "Brochure", "brochure"),
    ("05-talking-points.md", "Talking Points", "talking"),
    ("06-ip-summary.md", "IP Summary", "ip"),
]
# Floor: every CMNDI tier requires at least 02 + 03.
MIN_REQUIRED = {"02-technical-spec.md", "03-end-user-guide.md"}
_BUILD_DATETIME: datetime | None = None


def first_env(*names: str) -> str | None:
    for name in names:
        value = os.environ.get(name)
        if value is not None and value.strip():
            return value.strip()
    return None


def build_datetime() -> datetime:
    global _BUILD_DATETIME
    if _BUILD_DATETIME is not None:
        return _BUILD_DATETIME

    raw = first_env("LODESTONE_DOCS_BUILD_TIMESTAMP", "CMNDI_DOCS_BUILD_TIMESTAMP")
    if raw is None:
        raw = first_env("SOURCE_DATE_EPOCH")
    if raw is None:
        _BUILD_DATETIME = datetime.now(timezone.utc)
        return _BUILD_DATETIME

    if raw.isdigit():
        _BUILD_DATETIME = datetime.fromtimestamp(int(raw), timezone.utc)
        return _BUILD_DATETIME

    normalized = raw.removesuffix(" UTC").replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError as exc:
        raise SystemExit(
            "LODESTONE_DOCS_BUILD_TIMESTAMP/CMNDI_DOCS_BUILD_TIMESTAMP must be "
            "an ISO-8601 timestamp or SOURCE_DATE_EPOCH must be an epoch second"
        ) from exc
    if parsed.tzinfo is None:
        _BUILD_DATETIME = parsed.replace(tzinfo=timezone.utc)
        return _BUILD_DATETIME
    _BUILD_DATETIME = parsed.astimezone(timezone.utc)
    return _BUILD_DATETIME


def slugify(text: str) -> str:
    s = re.sub(r"[^\w\s-]", "", text.lower()).strip()
    return re.sub(r"[\s_]+", "-", s)


def md_to_html(md: str, doc_id: str) -> tuple[str, list[tuple[int, str, str]]]:
    """Minimal markdown → HTML. Tracks (depth, anchor, title) for TOC."""
    lines = md.splitlines()
    out: list[str] = []
    toc: list[tuple[int, str, str]] = []
    in_code = False
    in_table = False
    in_list = False
    list_kind = None  # 'ul' or 'ol'
    in_blockquote = False

    def close_lists() -> None:
        nonlocal in_list, list_kind
        if in_list:
            out.append(f"</{list_kind}>")
            in_list = False
            list_kind = None

    def close_quote() -> None:
        nonlocal in_blockquote
        if in_blockquote:
            out.append("</blockquote>")
            in_blockquote = False

    def close_table() -> None:
        nonlocal in_table
        if in_table:
            out.append("</tbody></table>")
            in_table = False

    def inline(s: str) -> str:
        s = html.escape(s, quote=False)
        # code spans
        s = re.sub(r"`([^`]+)`", r"<code>\1</code>", s)
        # bold + italic
        s = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", s)
        s = re.sub(r"(?<!\*)\*([^*]+)\*(?!\*)", r"<em>\1</em>", s)
        # links
        s = re.sub(
            r"\[([^\]]+)\]\(([^)]+)\)",
            r'<a href="\2">\1</a>',
            s,
        )
        return s

    i = 0
    while i < len(lines):
        line = lines[i]
        stripped = line.rstrip()

        # fenced code blocks
        if stripped.startswith("```"):
            close_lists()
            close_quote()
            close_table()
            if not in_code:
                lang = stripped[3:].strip()
                out.append(f'<pre><code class="lang-{html.escape(lang)}">')
                in_code = True
            else:
                out.append("</code></pre>")
                in_code = False
            i += 1
            continue
        if in_code:
            out.append(html.escape(line, quote=False))
            i += 1
            continue

        # tables: lookahead for ---|--- separator
        if "|" in stripped and i + 1 < len(lines) and re.match(r"^\s*\|?\s*[-:]+", lines[i + 1]):
            close_lists()
            close_quote()
            headers = [h.strip() for h in stripped.strip("|").split("|")]
            out.append("<table><thead><tr>")
            for h in headers:
                out.append(f"<th>{inline(h)}</th>")
            out.append("</tr></thead><tbody>")
            in_table = True
            i += 2  # skip separator
            while i < len(lines) and "|" in lines[i] and lines[i].strip():
                cells = [c.strip() for c in lines[i].strip().strip("|").split("|")]
                out.append("<tr>")
                for c in cells:
                    out.append(f"<td>{inline(c)}</td>")
                out.append("</tr>")
                i += 1
            close_table()
            continue

        # headings
        m = re.match(r"^(#{1,6})\s+(.*)", stripped)
        if m:
            close_lists()
            close_quote()
            close_table()
            depth = len(m.group(1))
            title = m.group(2).strip()
            anchor = f"{doc_id}-{slugify(title)}"
            toc.append((depth, anchor, title))
            out.append(f'<h{depth} id="{anchor}">{inline(title)}</h{depth}>')
            i += 1
            continue

        # blockquote
        if stripped.startswith("> "):
            close_lists()
            close_table()
            if not in_blockquote:
                out.append("<blockquote>")
                in_blockquote = True
            out.append(f"<p>{inline(stripped[2:])}</p>")
            i += 1
            continue
        if in_blockquote and stripped == "":
            close_quote()

        # unordered list
        m = re.match(r"^[-*]\s+(.*)", stripped)
        if m:
            close_quote()
            close_table()
            if not in_list or list_kind != "ul":
                close_lists()
                out.append("<ul>")
                in_list = True
                list_kind = "ul"
            out.append(f"<li>{inline(m.group(1))}</li>")
            i += 1
            continue

        # ordered list
        m = re.match(r"^\d+\.\s+(.*)", stripped)
        if m:
            close_quote()
            close_table()
            if not in_list or list_kind != "ol":
                close_lists()
                out.append("<ol>")
                in_list = True
                list_kind = "ol"
            out.append(f"<li>{inline(m.group(1))}</li>")
            i += 1
            continue

        # horizontal rule
        if re.match(r"^-{3,}\s*$", stripped):
            close_lists()
            close_quote()
            close_table()
            out.append("<hr/>")
            i += 1
            continue

        # blank line
        if stripped == "":
            close_lists()
            close_quote()
            i += 1
            continue

        # paragraph
        close_lists()
        close_table()
        if not in_blockquote:
            out.append(f"<p>{inline(stripped)}</p>")
        i += 1

    close_lists()
    close_quote()
    close_table()
    if in_code:
        out.append("</code></pre>")

    return "\n".join(out), toc


CSS = """
:root {
  --bg: #080808;
  --fg: #d8d8d8;
  --muted: #8a8a8a;
  --accent: #76B900;
  --panel: #111;
  --border: #222;
  --code-bg: #161616;
  --link: #76B900;
  --mono: 'JetBrains Mono', 'Menlo', 'Monaco', 'Consolas', monospace;
  --sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
}
* { box-sizing: border-box; }
html, body {
  margin: 0; padding: 0;
  background: var(--bg); color: var(--fg);
  font-family: var(--sans); font-size: 15px; line-height: 1.55;
}
a { color: var(--link); text-decoration: none; }
a:hover { text-decoration: underline; }
.layout { display: grid; grid-template-columns: 280px 1fr; min-height: 100vh; }
nav.toc {
  background: var(--panel); border-right: 1px solid var(--border);
  padding: 18px 14px 28px; overflow-y: auto; max-height: 100vh; position: sticky; top: 0;
}
.brand {
  font-family: var(--mono); color: var(--accent);
  font-weight: 700; font-size: 14px; letter-spacing: 0.5px;
  padding-bottom: 10px; border-bottom: 1px solid var(--border); margin-bottom: 12px;
}
.brand small { display: block; color: var(--muted); font-weight: 400; font-size: 11px; margin-top: 4px; }
.search {
  width: 100%; background: var(--bg); color: var(--fg);
  border: 1px solid var(--border); padding: 6px 8px;
  font-family: var(--mono); font-size: 12px; margin-bottom: 12px;
}
.search:focus { outline: none; border-color: var(--accent); }
.toc-section {
  margin-top: 14px; font-family: var(--mono); font-size: 11px;
  color: var(--accent); text-transform: uppercase; letter-spacing: 0.5px;
}
nav.toc ul { list-style: none; padding: 0; margin: 4px 0 0; }
nav.toc li { padding: 2px 0; }
nav.toc a { color: var(--fg); display: block; padding: 2px 0; font-size: 13px; }
nav.toc a:hover { color: var(--accent); }
nav.toc .h1 { padding-left: 0; }
nav.toc .h2 { padding-left: 10px; font-size: 12px; }
nav.toc .h3 { padding-left: 22px; font-size: 12px; color: var(--muted); }
nav.toc .h4, nav.toc .h5, nav.toc .h6 { padding-left: 32px; font-size: 11px; color: var(--muted); }
main {
  padding: 32px 56px 64px; max-width: 980px;
}
main h1 { font-family: var(--mono); color: var(--accent); border-bottom: 2px solid var(--border); padding-bottom: 8px; margin-top: 48px; }
main h1:first-child { margin-top: 0; }
main h2 { font-family: var(--mono); color: var(--accent); margin-top: 32px; }
main h3, main h4, main h5, main h6 { font-family: var(--mono); color: var(--fg); margin-top: 22px; }
main code {
  font-family: var(--mono); font-size: 90%;
  background: var(--code-bg); padding: 1px 5px; border-radius: 2px; color: var(--accent);
}
main pre {
  background: var(--code-bg); border: 1px solid var(--border);
  padding: 12px 14px; overflow-x: auto;
}
main pre code { background: transparent; padding: 0; color: var(--fg); }
main blockquote {
  border-left: 3px solid var(--accent);
  padding: 4px 14px; margin: 14px 0;
  background: rgba(118,185,0,0.04); color: var(--muted);
}
main table { border-collapse: collapse; margin: 14px 0; width: 100%; font-size: 14px; }
main th, main td { border: 1px solid var(--border); padding: 7px 11px; text-align: left; vertical-align: top; }
main th { background: var(--panel); color: var(--accent); font-family: var(--mono); font-size: 12px; }
main hr { border: none; border-top: 1px solid var(--border); margin: 32px 0; }
.doc-section { padding: 36px 0; border-bottom: 1px solid var(--border); }
.footer {
  margin-top: 48px; padding-top: 16px; border-top: 1px solid var(--border);
  color: var(--muted); font-family: var(--mono); font-size: 11px;
}
.toc-hidden { display: none !important; }
@media (max-width: 768px) {
  .layout { grid-template-columns: 1fr; }
  nav.toc { position: static; max-height: none; }
  main { padding: 24px 18px; }
}
"""

JS = """
(() => {
  const search = document.querySelector('.search');
  if (!search) return;
  search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    document.querySelectorAll('nav.toc li').forEach(li => {
      const a = li.querySelector('a');
      if (!a) return;
      const hit = !q || a.textContent.toLowerCase().includes(q);
      li.classList.toggle('toc-hidden', !hit);
    });
  });
  // smooth scroll
  document.querySelectorAll('nav.toc a').forEach(a => {
    a.addEventListener('click', e => {
      const id = a.getAttribute('href').slice(1);
      const el = document.getElementById(id);
      if (el) { e.preventDefault(); el.scrollIntoView({ behavior: 'smooth', block: 'start' }); history.replaceState(null, '', '#' + id); }
    });
  });
})();
"""


def git_head() -> str:
    override = first_env("LODESTONE_DOCS_BUILD_COMMIT", "CMNDI_DOCS_BUILD_COMMIT")
    if override:
        return override
    try:
        return subprocess.check_output(
            ["git", "-C", str(REPO_ROOT), "rev-parse", "--short", "HEAD"],
            stderr=subprocess.DEVNULL,
        ).decode().strip()
    except Exception:
        return "unknown"


def git_branch() -> str:
    override = first_env("LODESTONE_DOCS_BUILD_BRANCH", "CMNDI_DOCS_BUILD_BRANCH")
    if override:
        return override
    try:
        return subprocess.check_output(
            ["git", "-C", str(REPO_ROOT), "rev-parse", "--abbrev-ref", "HEAD"],
            stderr=subprocess.DEVNULL,
        ).decode().strip()
    except Exception:
        return "unknown"


def main() -> int:
    if not SRC_DIR.is_dir():
        print(f"error: {SRC_DIR} does not exist", file=sys.stderr)
        return 2
    # Tier-aware: require only the floor (02 + 03), include any other
    # ALL_DOCS entry that happens to be PRESENT, skip the rest silently.
    missing_floor = [name for name in MIN_REQUIRED if not (SRC_DIR / name).exists()]
    if missing_floor:
        print(
            f"error: missing tier-floor required files: {', '.join(missing_floor)}",
            file=sys.stderr,
        )
        return 2
    present = [(name, title, doc_id) for name, title, doc_id in ALL_DOCS
               if (SRC_DIR / name).exists()]

    docs_html: list[str] = []
    full_toc: list[tuple[str, str, list[tuple[int, str, str]]]] = []
    for name, title, doc_id in present:
        md = (SRC_DIR / name).read_text(encoding="utf-8")
        body, toc = md_to_html(md, doc_id)
        section_anchor = f"section-{doc_id}"
        docs_html.append(
            f'<section class="doc-section" id="{section_anchor}">{body}</section>'
        )
        full_toc.append((doc_id, title, toc))

    # Build TOC HTML
    toc_html: list[str] = []
    for doc_id, title, headings in full_toc:
        toc_html.append(f'<div class="toc-section">{html.escape(title)}</div>')
        toc_html.append("<ul>")
        for depth, anchor, text in headings:
            cls = f"h{depth}"
            toc_html.append(f'<li class="{cls}"><a href="#{anchor}">{html.escape(text)}</a></li>')
        toc_html.append("</ul>")

    head = git_head()
    branch = git_branch()
    timestamp = build_datetime().strftime("%Y-%m-%d %H:%M:%S UTC")

    out = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>CMNDI Platform — Documentation</title>
<style>{CSS}</style>
</head>
<body>
<div class="layout">
  <nav class="toc">
    <div class="brand">CMNDI<small>{html.escape(branch)} · {html.escape(head)}<br/>{timestamp}</small></div>
    <input class="search" placeholder="filter sections…" autocomplete="off"/>
    {''.join(toc_html)}
  </nav>
  <main>
    {''.join(docs_html)}
    <div class="footer">
      Generated by <code>scripts/docs/cmndi-docs-build.py</code> per CMNDI-DOCS-MANDATE-001.<br/>
      Source markdown: <code>docs/cmndi/0[1-6]-*.md</code> &nbsp;·&nbsp; Build: <code>{html.escape(head)}</code> on <code>{html.escape(branch)}</code>.
    </div>
  </main>
</div>
<script>{JS}</script>
</body>
</html>
"""
    OUT_HTML.write_text(out, encoding="utf-8")
    print(f"wrote {OUT_HTML} ({len(out):,} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
