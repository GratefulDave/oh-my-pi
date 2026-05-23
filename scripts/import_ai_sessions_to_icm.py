#!/usr/bin/env python3
"""Import AI-agent sessions for the current git repo into ICM memories.

Run from a git repository root (or any subdirectory inside one):

    python3 scripts/import_ai_sessions_to_icm.py --dry-run
    python3 scripts/import_ai_sessions_to_icm.py

The script discovers local session stores for Claude Code, OpenCode, Gemini CLI,
Antigravity, Antigravity 2.0, Forge, Codex CLI, and Codex app. It shows a Rich
selection table, asks which sessions to import, converts non-ICM-native formats to
plain transcript files, and calls `icm import` so ICM performs fact extraction and
stores memories under the selected project name.
"""

from __future__ import annotations

import argparse
from datetime import datetime
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

try:
    from rich.console import Console
    from rich.progress import BarColumn, Progress, SpinnerColumn, TextColumn, TimeElapsedColumn
    from rich.prompt import Confirm, Prompt
    from rich.table import Table
except ImportError:  # pragma: no cover - exercised by users without rich installed
    print("This script requires rich. Install with: python3 -m pip install rich", file=sys.stderr)
    raise SystemExit(2)

console = Console()
HOME = Path.home()
MAX_BLOB_BYTES = 2_000_000
MAX_TRANSCRIPT_CHARS = 300_000
TEXT_EXTENSIONS = {".jsonl", ".json", ".txt", ".md", ".log"}
SECRET_PATTERNS = [
    re.compile(r"(?i)(authorization\\s*[:=]\\s*bearer\\s+)[A-Za-z0-9._~+/=-]{12,}"),
    re.compile(r"(?i)(api[_-]?key\\s*[:=]\\s*)[A-Za-z0-9._~+/=-]{12,}"),
    re.compile(r"(?i)(token\\s*[:=]\\s*)[A-Za-z0-9._~+/=-]{12,}"),
    re.compile(r"\\b[A-Za-z0-9_-]{32,}\\.[A-Za-z0-9_-]{16,}\\.[A-Za-z0-9_-]{16,}\\b"),
    re.compile(r"\\b(?:sk|sk-proj|ghp|github_pat|d19d)[A-Za-z0-9_\\-]{20,}\\b"),
]


@dataclass(frozen=True)
class Candidate:
    source: str
    session_id: str
    title: str
    location: Path
    updated: float
    native_format: str | None = None
    generated_text: str | None = None

    @property
    def display_title(self) -> str:
        return self.title or self.session_id


def run(args: Sequence[str], cwd: Path | None = None, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, cwd=cwd, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=check)

def run_with_progress(args: Sequence[str], description: str) -> subprocess.CompletedProcess[str]:
    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        TimeElapsedColumn(),
        console=console,
        transient=True,
    ) as progress:
        task_id = progress.add_task(description, total=None)
        proc = subprocess.Popen(
            args,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        while proc.poll() is None:
            progress.advance(task_id)
            progress.refresh()
            time.sleep(0.1)
        stdout, stderr = proc.communicate()
        progress.update(task_id, completed=1)
    return subprocess.CompletedProcess(args, proc.returncode, stdout, stderr)


def git_root() -> Path:
    result = run(["git", "rev-parse", "--show-toplevel"], check=True)
    return Path(result.stdout.strip()).resolve()


def git_project_name(root: Path) -> str:
    try:
        url = run(["git", "config", "--get", "remote.origin.url"], cwd=root, check=False).stdout.strip()
    except Exception:
        url = ""
    if url:
        name = url.rstrip("/").split("/")[-1]
        if name.endswith(".git"):
            name = name[:-4]
        if name:
            return name
    return root.name


def claude_project_dir(root: Path) -> Path:
    return HOME / ".claude" / "projects" / str(root).replace("/", "-")


def safe_stat_mtime(path: Path) -> float:
    try:
        return path.stat().st_mtime
    except OSError:
        return 0.0


def discover_claude(root: Path) -> list[Candidate]:
    base = claude_project_dir(root)
    if not base.is_dir():
        return []
    out: list[Candidate] = []
    for path in sorted(base.glob("*.jsonl")):
        if path.stat().st_size <= 3:
            continue
        text = parse_jsonl_transcript(path)
        if not text.strip():
            continue
        out.append(
            Candidate(
                source="claude-code",
                session_id=path.stem,
                title=path.stem,
                location=path,
                updated=safe_stat_mtime(path),
                generated_text=text,
            )
        )
    return out


def extract_json_text(value: object) -> str:
    parts: list[str] = []

    def walk(v: object) -> None:
        if isinstance(v, str):
            if v.strip():
                parts.append(v)
        elif isinstance(v, list):
            for item in v:
                walk(item)
        elif isinstance(v, dict):
            # Prefer common content fields before recursively walking metadata.
            for key in ("text", "content", "message", "summary", "title"):
                if key in v:
                    walk(v[key])
            if not any(key in v for key in ("text", "content", "message")):
                for item in v.values():
                    walk(item)

    walk(value)
    return "\n".join(dict.fromkeys(p for p in parts if len(p.strip()) > 1))

def redact_secrets(text: str) -> str:
    redacted = text
    for pattern in SECRET_PATTERNS:
        if pattern.groups >= 1:
            redacted = pattern.sub(lambda match: f"{match.group(1)}[REDACTED]", redacted)
        else:
            redacted = pattern.sub("[REDACTED]", redacted)
    return redacted


def mentions_repo_path(text: str, root: Path) -> bool:
    root_text = re.escape(str(root))
    return re.search(rf"(?:file://)?{root_text}(?=$|[/\s`\"'<>)\],])", text) is not None


def parse_jsonl_transcript(path: Path) -> str:
    lines: list[str] = []
    with path.open("r", encoding="utf-8", errors="ignore") as handle:
        for raw in handle:
            raw = raw.strip()
            if not raw:
                continue
            try:
                obj = json.loads(raw)
            except json.JSONDecodeError:
                continue
            role = ""
            text = ""
            if isinstance(obj, dict):
                payload = obj.get("payload") if isinstance(obj.get("payload"), dict) else obj
                if isinstance(payload, dict):
                    role = str(payload.get("role") or payload.get("type") or obj.get("type") or "entry")
                    text = extract_json_text(payload)
                if not text:
                    role = str(obj.get("role") or obj.get("type") or "entry")
                    text = extract_json_text(obj)
            if text:
                lines.append(f"[{role}] {text}")
            if sum(len(line) for line in lines) > MAX_TRANSCRIPT_CHARS:
                lines.append("[truncated] transcript exceeded importer character cap")
                break
    return redact_secrets("\n\n".join(lines))


def discover_gemini(root: Path) -> list[Candidate]:
    out: list[Candidate] = []
    tmp = HOME / ".gemini" / "tmp"
    if not tmp.is_dir():
        return out
    for project_root_file in tmp.glob("*/.project_root"):
        try:
            recorded = Path(project_root_file.read_text(encoding="utf-8").strip()).resolve()
        except OSError:
            continue
        if recorded != root:
            continue
        chats = project_root_file.parent / "chats"
        for path in sorted(chats.glob("*.jsonl")):
            text = parse_jsonl_transcript(path)
            if not text.strip():
                continue
            out.append(
                Candidate(
                    source="gemini-cli",
                    session_id=path.stem,
                    title=path.stem,
                    location=path,
                    updated=safe_stat_mtime(path),
                    generated_text=text,
                )
            )
    return out


def connect_ro(path: Path) -> sqlite3.Connection | None:
    if not path.exists():
        return None
    try:
        conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        conn.row_factory = sqlite3.Row
        return conn
    except sqlite3.Error:
        return None


def discover_opencode(root: Path) -> list[Candidate]:
    db = HOME / ".local" / "share" / "opencode" / "opencode.db"
    conn = connect_ro(db)
    if conn is None:
        return []
    out: list[Candidate] = []
    try:
        rows = conn.execute(
            "SELECT id, title, directory, time_updated FROM session WHERE directory = ? ORDER BY time_updated DESC",
            (str(root),),
        ).fetchall()
        for row in rows:
            parts = conn.execute(
                "SELECT data FROM part WHERE session_id = ? ORDER BY time_created ASC",
                (row["id"],),
            ).fetchall()
            transcript: list[str] = []
            for part in parts:
                try:
                    data = json.loads(part["data"])
                except Exception:
                    continue
                if data.get("type") != "text":
                    continue
                text = str(data.get("text") or "").strip()
                if text:
                    transcript.append(text)
                if sum(len(item) for item in transcript) > MAX_TRANSCRIPT_CHARS:
                    transcript.append("[truncated] transcript exceeded importer character cap")
                    break
            if not transcript:
                continue
            out.append(
                Candidate(
                    source="opencode",
                    session_id=row["id"],
                    title=row["title"] or row["id"],
                    location=db,
                    updated=float(row["time_updated"] or 0) / 1000,
                    generated_text=redact_secrets("\n\n".join(transcript)),
                )
            )
    finally:
        conn.close()
    return out


def discover_codex(root: Path) -> list[Candidate]:
    db = HOME / ".codex" / "state_5.sqlite"
    conn = connect_ro(db)
    if conn is None:
        return []
    out: list[Candidate] = []
    try:
        rows = conn.execute(
            "SELECT id, rollout_path, source, title, updated_at FROM threads WHERE cwd = ? ORDER BY updated_at DESC",
            (str(root),),
        ).fetchall()
        for row in rows:
            path = Path(row["rollout_path"] or "")
            if not path.exists():
                continue
            text = parse_jsonl_transcript(path)
            if not text.strip():
                continue
            source_raw = str(row["source"] or "").lower()
            source = "codex-app" if "app" in source_raw else "codex-cli"
            out.append(
                Candidate(
                    source=source,
                    session_id=row["id"],
                    title=row["title"] or path.stem,
                    location=path,
                    updated=float(row["updated_at"] or safe_stat_mtime(path)),
                    generated_text=text,
                )
            )
    finally:
        conn.close()
    return out


def printable_blob_text(blob: bytes) -> str:
    if not blob:
        return ""
    blob = blob[:MAX_BLOB_BYTES]
    # Extract printable UTF-8-ish runs from protobuf/SQLite blobs without needing schemas.
    text = blob.decode("utf-8", errors="ignore")
    runs = re.findall(r"[\x09\x0A\x0D\x20-\x7E]{24,}", text)
    return "\n".join(run.strip() for run in runs if run.strip())


def discover_antigravity(root: Path, source: str, base: Path) -> list[Candidate]:
    if not base.is_dir():
        return []
    out: list[Candidate] = []
    for db in sorted(base.glob("*.db")):
        conn = connect_ro(db)
        if conn is None:
            continue
        try:
            chunks: list[str] = []
            for table, columns in (
                ("steps", ("metadata", "task_details", "render_info", "step_payload")),
                ("trajectory_metadata_blob", ("data",)),
            ):
                try:
                    rows = conn.execute(f"SELECT {', '.join(columns)} FROM {table}").fetchall()
                except sqlite3.Error:
                    continue
                for row in rows:
                    for column in columns:
                        value = row[column]
                        if isinstance(value, bytes):
                            text = printable_blob_text(value)
                        elif value is None:
                            text = ""
                        else:
                            text = str(value)
                        if text:
                            chunks.append(text)
                    if sum(len(c) for c in chunks) > MAX_TRANSCRIPT_CHARS:
                        break
            text = "\n\n".join(chunks)
            if not mentions_repo_path(text, root):
                continue
            out.append(
                Candidate(
                    source=source,
                    session_id=db.stem,
                    title=db.stem,
                    location=db,
                    updated=safe_stat_mtime(db),
                    generated_text=redact_secrets(text[:MAX_TRANSCRIPT_CHARS]),
                )
            )
        finally:
            conn.close()
    return out


def discover_forge(root: Path) -> list[Candidate]:
    db = HOME / ".forge" / ".forge.db"
    conn = connect_ro(db)
    if conn is None:
        return []
    out: list[Candidate] = []
    try:
        rows = conn.execute("SELECT conversation_id, title, context, updated_at, created_at FROM conversations").fetchall()
        for row in rows:
            text = str(row["context"] or "").strip()
            title = str(row["title"] or row["conversation_id"])
            if not mentions_repo_path(text, root) and not mentions_repo_path(title, root):
                continue
            if not text:
                continue
            out.append(
                Candidate(
                    source="forge",
                    session_id=row["conversation_id"],
                    title=title,
                    location=db,
                    updated=safe_stat_mtime(db),
                    generated_text=redact_secrets(text),
                )
            )
    finally:
        conn.close()
    return out


def discover_all(root: Path, enabled_sources: set[str] | None = None) -> list[Candidate]:
    discoverers = [
        ("claude-code", lambda: discover_claude(root)),
        ("gemini-cli", lambda: discover_gemini(root)),
        ("opencode", lambda: discover_opencode(root)),
        ("antigravity", lambda: discover_antigravity(root, "antigravity", HOME / ".gemini" / "antigravity" / "conversations")),
        (
            "antigravity-2",
            lambda: discover_antigravity(root, "antigravity-2", HOME / ".gemini" / "antigravity-ide" / "conversations"),
        ),
        ("forge", lambda: discover_forge(root)),
        ("codex", lambda: discover_codex(root)),
    ]
    candidates: list[Candidate] = []
    for name, discover in discoverers:
        if enabled_sources and name not in enabled_sources and not (name == "codex" and {"codex-cli", "codex-app"} & enabled_sources):
            continue
        try:
            candidates.extend(discover())
        except Exception as exc:
            console.print(f"[yellow]Warning:[/] {name} discovery failed: {exc}")
    if enabled_sources:
        candidates = [c for c in candidates if c.source in enabled_sources or ("codex" in enabled_sources and c.source.startswith("codex-"))]
    return sorted(candidates, key=lambda c: (c.source, -c.updated, c.title))


def format_session_time(timestamp: float) -> str:
    if timestamp <= 0:
        return "unknown"
    return datetime.fromtimestamp(timestamp).strftime("%Y-%m-%d %H:%M")


def render_candidates(candidates: Sequence[Candidate]) -> None:
    table = Table(title="AI sessions discovered for this repository")
    table.add_column("#", justify="right")
    table.add_column("Source")
    table.add_column("Updated")
    table.add_column("Title / Session")
    table.add_column("Location")
    table.add_column("Mode")
    for index, candidate in enumerate(candidates, start=1):
        mode = f"icm:{candidate.native_format}" if candidate.native_format else "converted:text"
        table.add_row(
            str(index),
            candidate.source,
            format_session_time(candidate.updated),
            candidate.display_title[:80],
            str(candidate.location).replace(str(HOME), "~")[:90],
            mode,
        )
    console.print(table)


def parse_selection(selection: str, total: int) -> set[int]:
    selection = selection.strip().lower()
    if selection in {"", "all", "a", "*"}:
        return set(range(1, total + 1))
    selected: set[int] = set()
    for part in selection.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            left, right = part.split("-", 1)
            start, end = int(left), int(right)
            selected.update(range(start, end + 1))
        else:
            selected.add(int(part))
    invalid = [i for i in selected if i < 1 or i > total]
    if invalid:
        raise ValueError(f"selection out of range: {invalid}")
    return selected


def write_generated_transcripts(candidates: Sequence[Candidate], tmp: Path) -> list[Candidate]:
    materialized: list[Candidate] = []
    for candidate in candidates:
        if candidate.native_format:
            materialized.append(candidate)
            continue
        text = redact_secrets(candidate.generated_text or "").strip()
        if not text:
            continue
        source_dir = tmp / candidate.source
        source_dir.mkdir(parents=True, exist_ok=True)
        path = source_dir / f"{candidate.session_id}.md"
        header = (
            f"# {candidate.source}: {candidate.display_title}\n\n"
            f"Source: `{candidate.location}`\n\n"
            f"Session updated: {format_session_time(candidate.updated)}\n\n"
        )
        path.write_text(header + text[:MAX_TRANSCRIPT_CHARS] + "\n", encoding="utf-8")
        materialized.append(
            Candidate(
                source=candidate.source,
                session_id=candidate.session_id,
                title=candidate.title,
                location=path,
                updated=candidate.updated,
                native_format="text",
            )
        )
    return materialized


def import_candidate(candidate: Candidate, project: str, dry_run: bool, icm_bin: str) -> bool:
    args = [icm_bin, "import", str(candidate.location), "--format", candidate.native_format or "auto", "--project", project]
    if dry_run:
        args.append("--dry-run")
    proc = run(args, check=False)
    if proc.stdout.strip():
        console.print(proc.stdout.strip())
    if proc.returncode != 0:
        console.print(f"[red]Import failed for {candidate.source}:{candidate.session_id}[/]")
        if proc.stderr.strip():
            console.print(proc.stderr.strip())
        return False
    return True


def default_import_topic(project: str) -> str:
    return f"context-{project}"


def erase_topic(topic: str, dry_run: bool, icm_bin: str) -> bool:
    if dry_run:
        console.print(f"[yellow]Dry run:[/] would erase ICM topic [bold]{topic}[/].")
        return True
    proc = run([icm_bin, "forget", "--topic", topic], check=False)
    if proc.stdout.strip():
        console.print(proc.stdout.strip())
    if proc.returncode != 0:
        console.print(f"[red]Failed to erase ICM topic {topic}[/]")
        if proc.stderr.strip():
            console.print(proc.stderr.strip())
        return False
    return True


def ensure_icm(icm_bin: str) -> None:
    if shutil.which(icm_bin) is None and not Path(icm_bin).exists():
        raise SystemExit(f"Cannot find icm binary: {icm_bin}")
    proc = run([icm_bin, "--version"], check=False)
    if proc.returncode != 0:
        raise SystemExit(proc.stderr.strip() or f"Failed to run {icm_bin} --version")


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", help="ICM project name. Defaults to git remote repo name or directory name.")
    parser.add_argument("--dry-run", action="store_true", help="Preview ICM extraction without storing memories.")
    parser.add_argument("--icm", default=os.environ.get("ICM_BIN", "icm"), help="Path to icm binary.")
    parser.add_argument(
        "--sources",
        help="Comma-separated source filter: claude-code,gemini-cli,opencode,antigravity,antigravity-2,forge,codex,codex-cli,codex-app",
    )
    parser.add_argument("--embed-force", action="store_true", help="Run `icm embed --force` after successful import.")
    parser.add_argument(
        "--replace-topic",
        action="store_true",
        help="Erase the existing default import topic (`context-<project>`) before importing selected sessions.",
    )
    args = parser.parse_args(argv)

    root = git_root()
    project = args.project or git_project_name(root)
    enabled_sources = {s.strip() for s in args.sources.split(",") if s.strip()} if args.sources else None

    ensure_icm(args.icm)
    console.print(f"[bold]Repository:[/] {root}")
    console.print(f"[bold]ICM project:[/] {project}")
    import_topic = default_import_topic(project)
    if args.replace_topic:
        console.print(f"[bold]Replacement topic:[/] {import_topic}")

    candidates = discover_all(root, enabled_sources)
    if not candidates:
        console.print("[yellow]No matching sessions found for this repository.[/]")
        return 0

    render_candidates(candidates)
    if not Confirm.ask("Import discovered sessions into ICM?", default=False):
        return 0
    raw = Prompt.ask("Which sessions? Use all, 1,3,5-8", default="all")
    selected_indexes = parse_selection(raw, len(candidates))

    selected = [candidate for index, candidate in enumerate(candidates, start=1) if index in selected_indexes]
    if not selected:
        console.print("[yellow]Nothing selected.[/]")
        return 0

    if args.replace_topic:
        if not Confirm.ask(f"Erase existing ICM topic {import_topic} before import?", default=False):
            console.print("[yellow]Topic replacement cancelled.[/]")
            return 0
        if not erase_topic(import_topic, args.dry_run, args.icm):
            return 1
    failures = 0
    with tempfile.TemporaryDirectory(prefix="icm-ai-session-import-") as tmp_raw:
        tmp = Path(tmp_raw)
        materialized = write_generated_transcripts(selected, tmp)
        progress = Table(title="Import plan")
        progress.add_column("Source")
        progress.add_column("Sessions", justify="right")
        for source in sorted({c.source for c in materialized}):
            progress.add_row(source, str(sum(1 for c in materialized if c.source == source)))
        console.print(progress)

        for candidate in materialized:
            console.rule(f"{candidate.source}: {candidate.display_title[:80]}")
            if not import_candidate(candidate, project, args.dry_run, args.icm):
                failures += 1

    if args.embed_force and not args.dry_run and failures == 0:
        proc = run_with_progress([args.icm, "embed", "--force"], "Embedding memories")
        if proc.stdout.strip():
            console.print(proc.stdout.strip())
        if proc.returncode != 0:
            failures += 1
            console.print(proc.stderr.strip())

    if failures:
        console.print(f"[red]Completed with {failures} failed import(s).[/]")
        return 1
    console.print("[green]Done.[/]")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
