#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Build Lodestone friend docs as DOCX, static HTML, and install-package docs."""

from __future__ import annotations

import html
import os
import re
import shutil
import subprocess
import zipfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

REPO_ROOT = Path(__file__).resolve().parents[2]
FRIEND_DIR = REPO_ROOT / "docs" / "friend"
WORD_DIR = FRIEND_DIR / "word"
SITE_DIR = REPO_ROOT / "docs" / "site"
PACKAGE_DOCS_DIR = REPO_ROOT / "packages" / "cli" / "docs"
REFERENCE_DOC = Path("/home/theferalmoon/genesis-project/office/CMNDI-Overview.docx")
DOC_FACTORY_CONTAINER = os.environ.get("LODESTONE_DOC_FACTORY_CONTAINER", "doc-factory")
DOCS_RENDERER = os.environ.get("LODESTONE_DOCS_RENDERER", "local").strip().lower()
INTERNAL_LEAK_TERMS = [
    "Document Agent Hooks",
    "doc-factory",
    "Captain's Log",
    "The Scribe",
    "USG Scribe",
    "Town Crier",
    "DocForge",
    "LODESTONE_DOCS_RENDERER",
    "LODESTONE_DOC_FACTORY_CONTAINER",
    "/home/theferalmoon",
    "local-opus-lab",
]
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

    raw = first_env("LODESTONE_DOCS_BUILD_TIMESTAMP")
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
            "LODESTONE_DOCS_BUILD_TIMESTAMP must be an ISO-8601 timestamp "
            "or SOURCE_DATE_EPOCH must be an epoch second"
        ) from exc
    if parsed.tzinfo is None:
        _BUILD_DATETIME = parsed.replace(tzinfo=timezone.utc)
        return _BUILD_DATETIME
    _BUILD_DATETIME = parsed.astimezone(timezone.utc)
    return _BUILD_DATETIME


def generated_stamp() -> str:
    return build_datetime().strftime("%Y-%m-%d %H:%M UTC")


def docx_zip_datetime() -> tuple[int, int, int, int, int, int]:
    dt = build_datetime()
    minimum = datetime(1980, 1, 1, tzinfo=timezone.utc)
    maximum = datetime(2107, 12, 31, 23, 59, 58, tzinfo=timezone.utc)
    if dt < minimum:
        dt = minimum
    if dt > maximum:
        dt = maximum
    return (dt.year, dt.month, dt.day, dt.hour, dt.minute, dt.second)


def docx_iso_stamp() -> str:
    return build_datetime().strftime("%Y-%m-%dT%H:%M:%SZ")


@dataclass(frozen=True)
class Doc:
    source: Path
    slug: str
    title: str
    group: str
    docx: bool = False


@dataclass(frozen=True)
class Renderer:
    name: str
    pandoc: str | None = None
    container: str | None = None


DOCS = [
    Doc(REPO_ROOT / "docs/friend/lodestone-feature-brochure.md", "feature-brochure", "Feature Brochure", "Friend Docs", True),
    Doc(REPO_ROOT / "docs/friend/lodestone-installation-guide.md", "installation-guide", "Installation Guide", "Friend Docs", True),
    Doc(REPO_ROOT / "docs/friend/lodestone-technical-guide.md", "technical-guide", "Technical Guide", "Friend Docs", True),
    Doc(REPO_ROOT / "README.md", "readme", "Repository README", "Core Docs"),
    Doc(REPO_ROOT / "docs/README.md", "docs-readme", "Technical Docs Overview", "Core Docs"),
    Doc(REPO_ROOT / "docs/FRIEND-INSTALL.md", "friend-install", "Friend Install Quickstart", "Core Docs"),
    Doc(REPO_ROOT / "docs/ARCHITECTURE.md", "architecture", "Architecture", "Technical Reference"),
    Doc(REPO_ROOT / "docs/CONFIG.md", "config", "Configuration", "Technical Reference"),
    Doc(REPO_ROOT / "docs/ROADMAP.md", "roadmap", "Roadmap", "Technical Reference"),
    Doc(REPO_ROOT / "docs/MCP-TOOLS.md", "mcp-tools", "MCP Tools", "Technical Reference"),
    Doc(REPO_ROOT / "docs/MCPB.md", "mcpb", "Claude Desktop MCPB", "Technical Reference"),
    Doc(REPO_ROOT / "docs/PRIVACY.md", "privacy", "Privacy", "Technical Reference"),
    Doc(REPO_ROOT / "docs/SUPPLY-CHAIN.md", "supply-chain", "Supply Chain", "Technical Reference"),
    Doc(REPO_ROOT / "docs/TROUBLESHOOTING.md", "troubleshooting", "Troubleshooting", "Technical Reference"),
    Doc(REPO_ROOT / "docs/UPGRADE.md", "upgrade", "Upgrade", "Technical Reference"),
    Doc(REPO_ROOT / "docs/DEMO-REPO.md", "demo-repo", "Demo Repository", "Technical Reference"),
    Doc(REPO_ROOT / "docs/KNOWN-ISSUES.md", "known-issues", "Known Issues", "Technical Reference"),
]


def run(cmd: list[str], *, capture: bool = False, check: bool = True) -> str:
    result = subprocess.run(
        cmd,
        cwd=REPO_ROOT,
        check=check,
        text=True,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,
    )
    return result.stdout if capture else ""


def require_pandoc() -> str:
    pandoc = shutil.which("pandoc")
    if not pandoc:
        raise SystemExit("pandoc is required to build DOCX and HTML docs")
    return pandoc


def docker_container_running(container: str) -> bool:
    if not shutil.which("docker"):
        return False
    result = subprocess.run(
        ["docker", "inspect", "-f", "{{.State.Running}}", container],
        cwd=REPO_ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )
    return result.returncode == 0 and result.stdout.strip() == "true"


def select_renderer() -> Renderer:
    if DOCS_RENDERER not in {"local", "auto", "doc-factory"}:
        raise SystemExit(
            "LODESTONE_DOCS_RENDERER must be one of: local, auto, doc-factory"
        )
    if DOCS_RENDERER in {"auto", "doc-factory"} and docker_container_running(DOC_FACTORY_CONTAINER):
        return Renderer("doc-factory", container=DOC_FACTORY_CONTAINER)
    if DOCS_RENDERER == "doc-factory":
        raise SystemExit(
            f"LODESTONE_DOCS_RENDERER=doc-factory requires a running {DOC_FACTORY_CONTAINER!r} container"
        )
    return Renderer("local", pandoc=require_pandoc())


def docfactory_pandoc(
    renderer: Renderer,
    source: Path,
    args: list[str],
    *,
    capture: bool = False,
    output: Path | None = None,
) -> str:
    if not renderer.container:
        raise RuntimeError("doc-factory renderer selected without a container")
    tmp = f"/tmp/lodestone-docs-{uuid4().hex}"
    input_name = f"input{source.suffix}"
    container = renderer.container
    try:
        run(["docker", "exec", container, "mkdir", "-p", tmp])
        run(["docker", "cp", str(source), f"{container}:{tmp}/{input_name}"])
        cmd = ["docker", "exec", container, "pandoc", *args, f"{tmp}/{input_name}"]
        if output:
            cmd.extend(["-o", f"{tmp}/output{output.suffix}"])
            if REFERENCE_DOC.exists():
                run(["docker", "cp", str(REFERENCE_DOC), f"{container}:{tmp}/reference.docx"])
                cmd[4:4] = [f"--reference-doc={tmp}/reference.docx"]
            run(cmd)
            output.parent.mkdir(parents=True, exist_ok=True)
            run(["docker", "cp", f"{container}:{tmp}/output{output.suffix}", str(output)])
            return ""
        return run(cmd, capture=capture)
    finally:
        run(["docker", "exec", container, "rm", "-rf", tmp], check=False)


def page_shell(title: str, body: str, current_slug: str) -> str:
    generated = generated_stamp()
    nav_items = []
    current_group = None
    for doc in DOCS:
        if doc.group != current_group:
            current_group = doc.group
            nav_items.append(f'<div class="nav-group">{html.escape(current_group)}</div>')
        active = ' class="active"' if doc.slug == current_slug else ""
        nav_items.append(
            f'<a{active} href="./{html.escape(doc.slug)}.html">{html.escape(doc.title)}</a>'
        )
    nav = "\n".join(nav_items)
    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{html.escape(title)} | Lodestone Docs</title>
  <style>
    :root {{
      --bg: #f6f8fb;
      --ink: #17202a;
      --muted: #65758b;
      --panel: #ffffff;
      --border: #d8dee8;
      --nav: #101722;
      --nav-ink: #e8eef7;
      --accent: #2c6e49;
      --accent-2: #0f4c81;
      --code: #edf2f7;
      --shadow: 0 14px 36px rgba(16, 23, 34, 0.10);
      --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      --mono: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
    }}
    * {{ box-sizing: border-box; }}
    body {{
      margin: 0;
      background: var(--bg);
      color: var(--ink);
      font-family: var(--sans);
      line-height: 1.55;
    }}
    .layout {{
      display: grid;
      grid-template-columns: 292px minmax(0, 1fr);
      min-height: 100vh;
    }}
    nav {{
      background: var(--nav);
      color: var(--nav-ink);
      padding: 22px 18px;
      position: sticky;
      top: 0;
      height: 100vh;
      overflow-y: auto;
    }}
    .brand {{
      font-weight: 800;
      letter-spacing: 0.03em;
      margin-bottom: 2px;
      font-size: 18px;
    }}
    .tagline {{
      color: #a9b6c7;
      font-size: 12px;
      margin-bottom: 22px;
    }}
    .nav-group {{
      color: #8ea0b7;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      margin: 18px 0 7px;
    }}
    nav a {{
      display: block;
      color: var(--nav-ink);
      text-decoration: none;
      padding: 8px 10px;
      border-radius: 6px;
      font-size: 14px;
    }}
    nav a:hover, nav a.active {{
      background: rgba(255, 255, 255, 0.10);
    }}
    main {{
      padding: 38px;
    }}
    article {{
      max-width: 980px;
      background: var(--panel);
      border: 1px solid var(--border);
      box-shadow: var(--shadow);
      border-radius: 8px;
      padding: 42px 52px;
    }}
    h1 {{
      font-size: 36px;
      line-height: 1.1;
      margin: 0 0 12px;
      color: #10213a;
    }}
    h2 {{
      font-size: 22px;
      margin-top: 34px;
      padding-top: 14px;
      border-top: 1px solid var(--border);
      color: var(--accent-2);
    }}
    h3 {{
      font-size: 17px;
      margin-top: 24px;
      color: var(--accent);
    }}
    p, li {{
      font-size: 15px;
    }}
    a {{
      color: var(--accent-2);
    }}
    code {{
      background: var(--code);
      padding: 2px 5px;
      border-radius: 4px;
      font-family: var(--mono);
      font-size: 0.92em;
    }}
    pre {{
      background: #111827;
      color: #f8fafc;
      padding: 16px;
      border-radius: 8px;
      overflow-x: auto;
    }}
    pre code {{
      background: transparent;
      color: inherit;
      padding: 0;
    }}
    table {{
      width: 100%;
      border-collapse: collapse;
      margin: 18px 0;
      font-size: 14px;
    }}
    th, td {{
      border: 1px solid var(--border);
      padding: 10px 12px;
      vertical-align: top;
    }}
    th {{
      background: #eef3f8;
      text-align: left;
    }}
    blockquote {{
      border-left: 4px solid var(--accent);
      margin-left: 0;
      padding-left: 16px;
      color: var(--muted);
    }}
    .doc-home {{
      display: grid;
      gap: 14px;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      margin-top: 22px;
    }}
    .doc-card {{
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 16px;
      background: #fbfcfe;
    }}
    .doc-card a {{
      font-weight: 700;
      text-decoration: none;
    }}
    footer {{
      max-width: 980px;
      color: var(--muted);
      font-size: 12px;
      margin-top: 16px;
    }}
    @media (max-width: 860px) {{
      .layout {{ display: block; }}
      nav {{
        height: auto;
        position: relative;
      }}
      main {{ padding: 18px; }}
      article {{ padding: 26px 20px; }}
      h1 {{ font-size: 29px; }}
    }}
  </style>
</head>
<body>
  <div class="layout">
    <nav>
      <div class="brand">Lodestone</div>
      <div class="tagline">Local code intelligence for AI coding agents</div>
      <a href="./index.html">Docs Home</a>
      {nav}
    </nav>
    <main>
      <article>
        {body}
      </article>
      <footer>Generated {generated} from repository Markdown sources.</footer>
    </main>
  </div>
</body>
</html>
"""


def build_docx(renderer: Renderer) -> None:
    WORD_DIR.mkdir(parents=True, exist_ok=True)
    for doc in DOCS:
        if not doc.docx:
            continue
        out = WORD_DIR / f"Lodestone-{doc.title.replace(' ', '-')}.docx"
        args = ["--from", "gfm", "--to", "docx", "--standalone"]
        if renderer.name == "doc-factory":
            docfactory_pandoc(renderer, doc.source, args, output=out)
        else:
            if not renderer.pandoc:
                raise RuntimeError("local renderer selected without pandoc")
            cmd = [renderer.pandoc, *args, "-o", str(out), str(doc.source)]
            if REFERENCE_DOC.exists():
                cmd[1:1] = [f"--reference-doc={REFERENCE_DOC}"]
            run(cmd)
        normalize_docx(out)


def normalize_docx(path: Path) -> None:
    """Normalize generated DOCX timestamps when stable build metadata is set."""
    zip_dt = docx_zip_datetime()
    iso = docx_iso_stamp()
    tmp = path.with_suffix(f"{path.suffix}.tmp")
    with zipfile.ZipFile(path, "r") as src, zipfile.ZipFile(
        tmp, "w", compression=zipfile.ZIP_DEFLATED
    ) as dst:
        for name in sorted(src.namelist()):
            data = src.read(name)
            if name == "docProps/core.xml":
                text = data.decode("utf-8", errors="ignore")
                for tag in ("created", "modified"):
                    text = re.sub(
                        rf"(<dcterms:{tag}\b[^>]*>).*?(</dcterms:{tag}>)",
                        rf"\g<1>{iso}\g<2>",
                        text,
                    )
                data = text.encode("utf-8")
            original = src.getinfo(name)
            info = zipfile.ZipInfo(name, zip_dt)
            info.compress_type = original.compress_type
            info.external_attr = original.external_attr
            info.comment = original.comment
            dst.writestr(info, data)
    tmp.replace(path)


def pandoc_body(renderer: Renderer, source: Path) -> str:
    args = ["--from", "gfm", "--to", "html"]
    if renderer.name == "doc-factory":
        return docfactory_pandoc(renderer, source, args, capture=True)
    if not renderer.pandoc:
        raise RuntimeError("local renderer selected without pandoc")
    return run([renderer.pandoc, *args, str(source)], capture=True)


def build_site(renderer: Renderer) -> None:
    if SITE_DIR.exists():
        shutil.rmtree(SITE_DIR)
    SITE_DIR.mkdir(parents=True)
    downloads = SITE_DIR / "downloads"
    downloads.mkdir()

    cards = []
    for doc in DOCS:
        cards.append(
            f'<div class="doc-card"><a href="./{html.escape(doc.slug)}.html">{html.escape(doc.title)}</a>'
            f'<p>{html.escape(doc.group)}</p></div>'
        )

    word_links = []
    for docx in sorted(WORD_DIR.glob("*.docx")):
        shutil.copy2(docx, downloads / docx.name)
        word_links.append(f'<li><a href="./downloads/{html.escape(docx.name)}">{html.escape(docx.name)}</a></li>')

    index_body = "\n".join(
        [
            "<h1>Lodestone Documentation</h1>",
            "<p>Lodestone is a local code intelligence sidecar for AI coding agents. These docs include the friend brochure, layperson installation guide, technical reference, and generated HTML copies of the core repository docs.</p>",
            "<h2>Start Here</h2>",
            '<div class="doc-home">',
            "".join(cards),
            "</div>",
            "<h2>Word Documents</h2>",
            "<ul>",
            "".join(word_links),
            "</ul>",
            "<h2>Install Routes</h2>",
            "<p>The installer is non-interactive. Choose one command before running it; if you are not sure, use Lite.</p>",
            "<h3>Lite - recommended first install</h3>",
            "<pre><code>curl -sSfL https://lodestone.cmndi.ai/install | bash</code></pre>",
            "<h3>Full - larger embedder</h3>",
            "<pre><code>curl -sSfL https://lodestone.cmndi.ai/install | LODESTONE_PROFILE=full bash</code></pre>",
        ]
    )
    (SITE_DIR / "index.html").write_text(page_shell("Docs Home", index_body, ""), encoding="utf-8")

    for doc in DOCS:
        body = pandoc_body(renderer, doc.source)
        (SITE_DIR / f"{doc.slug}.html").write_text(page_shell(doc.title, body, doc.slug), encoding="utf-8")


def build_package_docs() -> None:
    if PACKAGE_DOCS_DIR.exists():
        shutil.rmtree(PACKAGE_DOCS_DIR)
    PACKAGE_DOCS_DIR.mkdir(parents=True)
    package_readme = (FRIEND_DIR / "README.md").read_text(encoding="utf-8")
    package_readme = package_readme.replace(
        "HTML copies are generated into [../site/](../site/) and published at:",
        "HTML copies are included in [html/](./html/) and published at:",
    )
    (PACKAGE_DOCS_DIR / "README.md").write_text(package_readme, encoding="utf-8")
    for doc in DOCS:
        if doc.source.is_relative_to(FRIEND_DIR):
            shutil.copy2(doc.source, PACKAGE_DOCS_DIR / doc.source.name)
    shutil.copytree(WORD_DIR, PACKAGE_DOCS_DIR / "word")
    shutil.copytree(SITE_DIR, PACKAGE_DOCS_DIR / "html")


def scan_text_for_internal_terms(text: str) -> list[str]:
    lowered = text.lower()
    return [term for term in INTERNAL_LEAK_TERMS if term.lower() in lowered]


def docx_public_text(path: Path) -> str:
    chunks: list[str] = []
    with zipfile.ZipFile(path) as docx:
        for name in docx.namelist():
            if (
                name.startswith("word/")
                or name.startswith("docProps/")
                or name.startswith("_rels/")
            ) and name.endswith((".xml", ".rels")):
                chunks.append(docx.read(name).decode("utf-8", errors="ignore"))
    return "\n".join(chunks)


def verify_no_internal_leaks() -> None:
    leaks: list[str] = []
    public_roots = [FRIEND_DIR, SITE_DIR, PACKAGE_DOCS_DIR]
    for root in public_roots:
        for path in sorted(root.rglob("*")):
            if not path.is_file():
                continue
            if path.suffix.lower() == ".docx":
                text = docx_public_text(path)
            elif path.suffix.lower() in {".html", ".md", ".txt", ".json"}:
                text = path.read_text(encoding="utf-8", errors="ignore")
            else:
                continue
            terms = scan_text_for_internal_terms(text)
            for term in terms:
                leaks.append(f"{path.relative_to(REPO_ROOT)} contains {term!r}")
    if leaks:
        sample = "\n".join(f"  - {item}" for item in leaks[:20])
        raise SystemExit(f"internal document-agent terms leaked into public docs:\n{sample}")


def main() -> int:
    renderer = select_renderer()
    build_docx(renderer)
    build_site(renderer)
    build_package_docs()
    verify_no_internal_leaks()
    print(f"[friend-docs] Renderer: {renderer.name}")
    print(f"[friend-docs] Word docs: {WORD_DIR}")
    print(f"[friend-docs] HTML site: {SITE_DIR}")
    print(f"[friend-docs] Package docs: {PACKAGE_DOCS_DIR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
