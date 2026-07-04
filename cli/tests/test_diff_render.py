"""diff_render mirrors desktop/qml/DiffReviewPanel.qml: a `diff`-kind chat
event's per-file stats/snippet formatting, tolerating both the single-file
event shape ({"path", "patch"}) and a multi-file one ({"files": [...]})."""

from rich.console import Console

from jarvis_cli.tui.diff_render import (
    MAX_DIFF_LINES,
    diff_stats,
    extract_diff_files,
    render_diff_event,
    render_diff_file,
)

SAMPLE_PATCH = (
    "diff --git a/foo.py b/foo.py\n"
    "--- a/foo.py\n"
    "+++ b/foo.py\n"
    "@@ -1,3 +1,4 @@\n"
    " unchanged line\n"
    "-old line one\n"
    "-old line two\n"
    "+new line one\n"
    "+new line two\n"
    "+new line three\n"
)


def _render_to_text(renderable) -> str:
    console = Console(width=80, record=True, force_terminal=False)
    console.print(renderable)
    return console.export_text()


def test_diff_stats_counts_added_and_removed_excluding_file_headers():
    added, removed = diff_stats(SAMPLE_PATCH)
    assert added == 3
    assert removed == 2


def test_diff_stats_ignores_plusplusplus_and_minusminusminus_headers():
    patch = "--- a/x\n+++ b/x\n+real add\n"
    added, removed = diff_stats(patch)
    assert added == 1
    assert removed == 0


def test_extract_diff_files_single_file_shape():
    files = extract_diff_files({"kind": "diff", "path": "foo.py", "patch": SAMPLE_PATCH})
    assert files == [{"path": "foo.py", "patch": SAMPLE_PATCH}]


def test_extract_diff_files_multi_file_shape():
    ev = {"kind": "diff", "files": [
        {"path": "a.py", "patch": "+a\n"},
        {"path": "b.py", "patch": "-b\n"},
    ]}
    files = extract_diff_files(ev)
    assert [f["path"] for f in files] == ["a.py", "b.py"]


def test_extract_diff_files_accepts_file_and_diff_key_aliases():
    files = extract_diff_files({"file": "aliased.py", "diff": "+x\n"})
    assert files == [{"path": "aliased.py", "patch": "+x\n"}]


def test_extract_diff_files_empty_event_returns_empty_list():
    assert extract_diff_files({}) == []


def test_render_diff_file_shows_filename_and_stat_chips():
    out = _render_to_text(render_diff_file("foo.py", SAMPLE_PATCH))
    assert "foo.py" in out
    assert "+3" in out
    assert "-2" in out


def test_render_diff_file_truncates_long_patches_with_a_count_note():
    long_patch = "\n".join(f"+line {i}" for i in range(MAX_DIFF_LINES + 10))
    out = _render_to_text(render_diff_file("big.py", long_patch))
    assert "10 more lines" in out


def test_render_diff_event_renders_every_file_and_the_command_hint():
    ev = {"kind": "diff", "files": [
        {"path": "a.py", "patch": "+a\n"},
        {"path": "b.py", "patch": "-b\n"},
    ]}
    out = _render_to_text(render_diff_event(ev))
    assert "a.py" in out and "b.py" in out
    assert "/stage" in out and "/commit" in out and "/revert" in out and "/openpr" in out


def test_render_diff_event_empty_does_not_crash():
    out = _render_to_text(render_diff_event({"kind": "diff"}))
    assert out.strip() != ""
