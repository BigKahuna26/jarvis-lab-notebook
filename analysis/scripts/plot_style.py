"""
Lab plotting standards — import this in every analysis script.

Usage:
    from plot_style import apply_style, COLORS, C, FIGURE_SIZES
    apply_style()

Style target: GraphPad Prism aesthetic — clean L-frame axes, inward ticks,
no grid, solid filled markers, minimal legend.
"""

import matplotlib as mpl
import matplotlib.pyplot as plt
from matplotlib.ticker import AutoMinorLocator

# ── Color palette ──────────────────────────────────────────────────────────────
# Lab palette — pink → violet → blue → teal, with dark variants rose & indigo.
# Colors are spaced widely in both hue and lightness for maximum readability.
# Ordering: use the first N colors for N conditions; 1+2 give maximum contrast.
COLORS = [
    "#F72585",  # pink   — vivid hot pink (light, warm)
    "#9900CC",  # violet — vivid purple-violet (medium, clearly not pink)
    "#0066FF",  # blue   — strong cobalt blue (medium, clearly not purple)
    "#00AAAA",  # teal   — vivid teal (medium, clearly green-blue)
    "#CC0055",  # rose   — deep crimson-rose (dark, warm accent)
    "#330099",  # indigo — deep blue-indigo (dark, cool accent)
    "#888888",  # gray   — neutral reference
    "#1A1A1A",  # black  — near-black / annotations
]

C = {
    "pink":    "#F72585",
    "violet":  "#9900CC",
    "blue":    "#0066FF",
    "teal":    "#00AAAA",
    "rose":    "#CC0055",
    "indigo":  "#330099",
    "gray":    "#888888",
    "black":   "#1A1A1A",
}

# ── Figure sizing ──────────────────────────────────────────────────────────────
# Follows Nature/Cell single- and double-column width guidelines
FIGURE_SIZES = {
    "single":  (3.35, 3.0),   # single column (~85 mm)
    "wide":    (4.75, 3.25),  # 1.5-column
    "double":  (6.85, 3.25),  # double column (~174 mm)
    "tall":    (3.35, 4.75),  # single column, tall (2-panel stack)
    "square":  (3.35, 3.35),  # square single column
}

# ── Core style ─────────────────────────────────────────────────────────────────

def apply_style():
    """
    Apply Prism-style rcParams globally.
    Call once before any plt calls.
    """
    mpl.rcParams.update({
        # --- Font ---
        "font.family":              "sans-serif",
        "font.sans-serif":          ["Helvetica Neue", "Helvetica", "Arial", "DejaVu Sans"],
        "font.size":                9,
        "axes.titlesize":           9,
        "axes.titleweight":         "bold",
        "axes.labelsize":           9,
        "axes.labelweight":         "bold",      # bold axis labels like Prism
        "xtick.labelsize":          8,
        "ytick.labelsize":          8,
        "legend.fontsize":          8,
        "legend.title_fontsize":    8.5,

        # --- Figure ---
        "figure.dpi":               150,
        "savefig.dpi":              300,
        "figure.facecolor":         "white",
        "savefig.facecolor":        "white",
        "savefig.bbox":             "tight",
        "savefig.pad_inches":       0.08,

        # --- Axes ---
        "axes.spines.top":          False,
        "axes.spines.right":        False,
        "axes.linewidth":           1.25,        # thicker L-frame, key Prism trait
        "axes.facecolor":           "white",
        "axes.prop_cycle":          mpl.cycler("color", COLORS),
        "axes.titlepad":            10,
        "axes.labelpad":            5,

        # --- No grid (Prism default) ---
        "axes.grid":                False,
        "axes.axisbelow":           True,

        # --- Lines & markers ---
        "lines.linewidth":          2.0,
        "lines.markersize":         7,
        "lines.markeredgewidth":    0,           # no edge — solid Prism-style markers
        "lines.solid_capstyle":     "round",
        "lines.solid_joinstyle":    "round",

        # --- Ticks: inward, prominent ---
        "xtick.direction":          "in",
        "ytick.direction":          "in",
        "xtick.major.width":        1.25,
        "ytick.major.width":        1.25,
        "xtick.minor.width":        0.8,
        "ytick.minor.width":        0.8,
        "xtick.major.size":         5.5,
        "ytick.major.size":         5.5,
        "xtick.minor.size":         3.0,
        "ytick.minor.size":         3.0,
        "xtick.minor.visible":      True,        # Prism shows minor ticks
        "ytick.minor.visible":      True,
        "xtick.major.pad":          4,
        "ytick.major.pad":          4,

        # --- Legend: no frame by default ---
        "legend.frameon":           False,
        "legend.borderpad":         0.4,
        "legend.handlelength":      1.2,
        "legend.handletextpad":     0.5,
        "legend.labelspacing":      0.35,
        "legend.columnspacing":     1.0,

        # --- Error bars ---
        "errorbar.capsize":         4,

        # --- Font embedding (required for journal submission) ---
        "pdf.fonttype":             42,   # TrueType embedding in PDF
        "ps.fonttype":              42,   # TrueType embedding in PostScript
        "svg.fonttype":             "none",  # text stays editable in Illustrator/Inkscape
    })


# ── Helpers ────────────────────────────────────────────────────────────────────

def prism_axes(ax, minor_x=True, minor_y=True):
    """
    Apply Prism-specific axis finishing touches that can't be set via rcParams:
    - offset the L-frame spines slightly (Prism's signature gap at origin)
    - add auto minor ticks

    Pass minor_x=False / minor_y=False for categorical axes, where minor ticks
    between category positions are meaningless (and, on a hidden spine, show up
    as stray dashes).
    """
    for spine in ("left", "bottom"):
        ax.spines[spine].set_position(("outward", 4))
    if minor_x:
        ax.xaxis.set_minor_locator(AutoMinorLocator(2))
    else:
        ax.xaxis.set_minor_locator(plt.NullLocator())
        ax.tick_params(axis="x", which="minor", length=0)
    if minor_y:
        ax.yaxis.set_minor_locator(AutoMinorLocator(2))
    else:
        ax.yaxis.set_minor_locator(plt.NullLocator())
        ax.tick_params(axis="y", which="minor", length=0)
    return ax


# ── Font glyph safety ─────────────────────────────────────────────────────────
# Helvetica Neue (the house font) has no arrows, triangles or box-drawing
# glyphs; matplotlib silently substitutes tofu boxes, which then ship in a PDF
# to a journal. check_glyphs() catches that before it leaves the machine.

_UNSAFE_GLYPHS = {
    "\u2191": "'higher'/'up'", "\u2193": "'lower'/'down'",
    "\u2192": "'to' or '->'",  "\u2190": "'from' or '<-'",
    "\u2197": "'higher'",      "\u2198": "'lower'",
    "\u25b2": "'higher'",      "\u25bc": "'lower'",
    "\u25cf": "'o'",           "\u2022": "'-'",
}


def check_glyphs(fig, strict=False):
    """
    Warn about characters the resolved font cannot render.

    Scans every text element in `fig` for glyphs known to be missing from the
    house font. Returns a list of (text, char, suggestion). With strict=True,
    raises instead of warning — use that in a CI/regression check.

    Safe and widely available: Δ · × — − ≥ ≤ ± ⁺ ⁻ ₂ ° α β γ μ
    Unsafe in Helvetica Neue: ↑ ↓ → ← ▲ ▼ ● •
    """
    import warnings

    from matplotlib.text import Text

    found = []
    # Match the Text CLASS, not "has a get_text attribute": ContourSet also
    # exposes get_text(), with a different signature (lev, fmt), so a duck-typed
    # match raises TypeError on any figure containing contours.
    for t in fig.findobj(match=lambda o: isinstance(o, Text)):
        s = t.get_text() or ""
        for ch, alt in _UNSAFE_GLYPHS.items():
            if ch in s:
                found.append((s, ch, alt))
    if found:
        msg = "font cannot render these glyphs (will print as boxes):\n" + "\n".join(
            f"    {ch!r} in {s[:48]!r} → use {alt}" for s, ch, alt in found)
        if strict:
            raise ValueError(msg)
        warnings.warn(msg, stacklevel=2)
    return found


def prism_axes_all(fig):
    """Apply prism_axes to every Axes in a figure."""
    for ax in fig.get_axes():
        prism_axes(ax)
    return fig


def despine(ax=None, axes=None):
    """Remove top and right spines."""
    targets = axes if axes else ([ax] if ax else [plt.gca()])
    for a in targets:
        a.spines["top"].set_visible(False)
        a.spines["right"].set_visible(False)


def finalize(fig=None, tight=True):
    """tight_layout + return figure."""
    f = fig or plt.gcf()
    if tight:
        f.tight_layout()
    return f


def save_fig(fig, path, formats=("pdf", "png"), dpi=600):
    """
    Save a figure in multiple formats from a single call.

    Default: PDF (vector, for submission) + PNG (raster, for previews).
    Vector formats (pdf, svg, eps) ignore dpi — use dpi only for raster.
    Auto-registers every save in data/figures/index.md.

    Examples
    --------
    save_fig(fig, "data/figures/TC_001/TC_001_ir_bar")
    save_fig(fig, "data/figures/TC_001/TC_001_ir_bar", formats=("svg", "png"))
    """
    import re
    import inspect
    import datetime
    from pathlib import Path

    stem = Path(path).with_suffix("")

    # Catch unrenderable glyphs before they ship into a PDF.
    check_glyphs(fig)

    # THE STYLE MUST BE INSTALLED BEFORE ANYTHING IS SAVED.
    #
    # `savefig.bbox = "tight"` is what expands the canvas to hold a suptitle
    # placed at y > 1 and a caption at negative y - the house layout for every
    # figure in this project. Without it both are drawn beyond the canvas edge
    # and CLIPPED AWAY, and the file keeps its raw figsize aspect. The result is
    # a panel that exists, carries correct data, and silently lost the title and
    # the methods caption that state its statistic and normalisation.
    #
    # That is precisely how the three D15 count panels shipped: a runner stage
    # drew them in process without calling apply_style(). No check could see it
    # - the numbers were right, the file was present, the links resolved, and
    # the collision auditor found nothing because a CLIPPED text artist collides
    # with nothing. Fail here instead, where the bypass actually happens.
    import matplotlib as _mpl
    if _mpl.rcParams.get("savefig.bbox") != "tight":
        raise RuntimeError(
            f"save_fig({stem.name}): savefig.bbox is "
            f"{_mpl.rcParams.get('savefig.bbox')!r}, not 'tight' — apply_style() "
            "was never called in this process. Saving now would clip the "
            "suptitle and the methods caption off the canvas. Call "
            "apply_style() before building figures."
        )

    saved = []
    for fmt in formats:
        out = stem.with_suffix(f".{fmt}")
        if fmt in ("pdf", "svg", "eps"):
            fig.savefig(out)
        else:
            fig.savefig(out, dpi=dpi)
        print(f"  Saved → {out}")
        saved.append(out)

    # ── Figure registry ───────────────────────────────────────────────────────
    vault = Path(__file__).parents[2]
    index = vault / "data" / "figures" / "index.md"

    caller = "unknown"
    for frame in inspect.stack():
        fn = frame.filename
        if fn != __file__ and not fn.startswith("<"):
            caller = Path(fn).name
            break

    m = re.search(r"TC[_-]?\d+", str(stem))
    exp_id = m.group(0).replace("-", "_") if m else "—"
    today = datetime.date.today().isoformat()
    fmts = ", ".join(p.suffix.lstrip(".") for p in saved)
    try:
        rel = stem.relative_to(vault)
    except ValueError:
        rel = stem
    png_rel = rel.with_suffix(".png")
    row = f"| {today} | {exp_id} | [[{png_rel}\\|{stem.name}]] | {caller} | {fmts} |"

    if not index.exists():
        index.parent.mkdir(parents=True, exist_ok=True)
        index.write_text(
            "# Figure Registry\n\n"
            "Auto-generated by `save_fig()`. Newest entries at top.\n\n"
            "| Date | Experiment | Figure | Script | Formats |\n"
            "|------|------------|--------|--------|---------|\n"
        )

    # One row per figure. A regenerated figure replaces its old row instead of
    # adding a second one, so the registry cannot grow past the number of
    # figures that exist (it had reached 2,424 rows for 292 figures).
    fig_key = f"[[{png_rel}\\|"
    lines = [ln for ln in index.read_text().splitlines() if fig_key not in ln]
    for i, line in enumerate(lines):
        if line.startswith("|---"):
            lines.insert(i + 1, row)
            break
    else:
        lines.append(row)
    index.write_text("\n".join(lines) + "\n")

    # ── Auto-link to current day file ─────────────────────────────────────────
    try:
        _link_figure_to_day_file(vault, stem, saved)
    except Exception as e:  # never break a save over a link - but say so
        print(f"  (day-file link skipped: {type(e).__name__}: {e})")


def _link_figure_to_day_file(vault, stem, saved):
    """Embed the figure in the experiment's latest day file - once."""
    import re
    from pathlib import Path

    m = re.search(r"(TC[_-]?\d+)", str(stem), re.IGNORECASE)
    if not m:
        return
    exp_id = m.group(1).upper().replace("-", "_")

    exp_dir = vault / "experiments"
    if not exp_dir.exists():
        return

    folders = sorted(
        [d for d in exp_dir.iterdir()
         if d.is_dir() and d.name.upper().startswith(exp_id)],
        reverse=True,
    )
    if not folders:
        return

    # Day files moved into days/ on 2026-09-06; older layouts kept them at the
    # experiment root. Look in both.
    exp_folder = folders[0]
    candidates = list(exp_folder.glob("*.md")) + list((exp_folder / "days").glob("*.md"))

    def _day_number(f):
        n = re.search(r"_day(\d+)", f.name, re.IGNORECASE)
        return int(n.group(1)) if n else None

    day_files = [f for f in candidates if _day_number(f) is not None]
    if not day_files:
        return

    # Highest day NUMBER. Sorting on the name puts day9 above day10, so every
    # figure past day 9 would have landed on day 9's file.
    day_file = max(day_files, key=_day_number)
    content = day_file.read_text()

    try:
        rel_png = stem.with_suffix(".png").relative_to(vault)
    except ValueError:
        rel_png = stem.with_suffix(".png")

    # Re-running an analysis script must not add a second copy of every figure.
    if f"![[{rel_png}]]" in content:
        return

    fmts = ", ".join(p.suffix.lstrip(".").upper() for p in saved)
    entry = f"- `{stem.name}` ({fmts}) — ![[{rel_png}]]"

    section = "## Figures Generated"
    if section in content:
        idx = content.index(section)
        after_header = content.index("\n", idx) + 1
        tail = content[after_header:]
        next_sec = re.search(r"^## ", tail, re.MULTILINE)
        if next_sec:
            insert_pos = after_header + next_sec.start()
            content = content[:insert_pos].rstrip() + "\n" + entry + "\n\n" + content[insert_pos:]
        else:
            content = content.rstrip() + "\n" + entry + "\n"
    else:
        content = content.rstrip() + f"\n\n{section}\n{entry}\n"

    day_file.write_text(content)
    print(f"  Linked → {day_file.name}")
