#!/usr/bin/env python3
"""
Auto-count bacterial colonies from plate photos and write results into an
experiment day file.

Usage
-----
  # Count every image in a folder, map images → constructs, update TC_001 Day 15
  python3 count_colonies.py "~/Downloads/TC_001 Plate Counts" \
        --exp TC_001 --day 15 \
        --map "IMG_7353=neg,IMG_7354=pos,IMG_7356=Cd22.1063,IMG_7357=Cd22.2653,IMG_7355=Cd22.3418"

  # Just count, don't touch any notes
  python3 count_colonies.py "~/Downloads/plates" --exp TC_001 --day 15 --dry-run

Labels
------
Pass `--map` as comma-separated IMGSTEM=LABEL pairs (IMGSTEM = filename without
extension). Reserved labels `neg` / `pos` are rendered as Neg control / Positive
control and are excluded from the "colonies per construct" summary. If no map is
given, a `plates.txt` file in the image folder is read (one `IMGSTEM=LABEL` per
line); failing that, the filename stem is used as the label.

Notes
-----
- HEIC images (iPhone) are converted to JPEG on the fly with macOS `sips`.
- The agar dish is found by its amber colour, so the lid (with handwriting) and
  benchtop are ignored automatically. Only the dish interior is counted.
- Counting uses white-tophat background subtraction + Otsu threshold + a
  distance-transform watershed to split touching colonies. Blobs are filtered by
  area and shape to reject glare streaks and lettering.
- Automated counts are estimates. An annotated montage is saved so every plate
  can be eyeballed; correct any count in the day-file table by hand if needed.
- The day-file write is idempotent: results live between
  `<!-- colony-counts:start -->` / `<!-- colony-counts:end -->` markers and are
  replaced in place on re-runs.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import tempfile
from datetime import date
from pathlib import Path

import numpy as np
from skimage import color, feature, filters, io, measure, morphology, segmentation, transform
from scipy import ndimage as ndi

VAULT_ROOT = Path(__file__).resolve().parents[2]
EXPERIMENTS_DIR = VAULT_ROOT / "experiments"
FIGURES_DIR = VAULT_ROOT / "data" / "figures"

# Whole image is resized to this width before analysis so detection parameters
# (in pixels) are stable across phones / crops.
WORK_WIDTH = 1100
# Colony area bounds (px² at WORK_WIDTH). Tuned for a full ~9 cm dish filling
# most of the frame; a colony is a few px across, glare/lawn smears are large.
AREA_MIN = 4
AREA_MAX = 300
ECC_MAX = 0.90          # reject elongated glare streaks / pen strokes
BG_SIGMA = 10           # gaussian background scale for flattening
THRESH_K = 4.5          # threshold = mean + K*std of flattened signal in-dish
ABS_FLOOR = 0.10        # colony must also be this much brighter than background
                        # (grayscale 0-1) — stops faint agar mottling scoring
GLARE_V = 0.82          # HSV value above this = specular glare, excluded
GLARE_DILATE = 7        # grow glare mask to swallow its soft reflection halo
RIM_ERODE = 18          # pull ROI in from the dish wall/meniscus
MARKER_MIN_DIST = 4     # min separation for watershed seeds


# ── Image loading ───────────────────────────────────────────────────────────────

def load_rgb(path: Path) -> np.ndarray:
    """Load an image as HxWx3 uint8, converting HEIC via `sips` if needed."""
    if path.suffix.lower() in (".heic", ".heif"):
        tmp = Path(tempfile.mkdtemp()) / (path.stem + ".jpg")
        subprocess.run(
            ["sips", "-s", "format", "jpeg", str(path), "--out", str(tmp)],
            check=True, capture_output=True,
        )
        path = tmp
    img = io.imread(path)
    if img.ndim == 2:
        img = color.gray2rgb(img)
    return img[..., :3]


def to_work(rgb: np.ndarray) -> np.ndarray:
    scale = WORK_WIDTH / rgb.shape[1]
    if scale < 1:
        rgb = transform.resize(
            rgb, (round(rgb.shape[0] * scale), WORK_WIDTH),
            anti_aliasing=True, preserve_range=True,
        ).astype(np.uint8)
    return rgb


# ── Detection ───────────────────────────────────────────────────────────────────

def find_agar_roi(rgb: np.ndarray) -> np.ndarray | None:
    """Boolean mask of the agar dish interior (largest amber circular region)."""
    R, G, B = (rgb[..., i].astype(float) for i in range(3))
    yellow = np.clip(np.minimum(R, G) - B, 0, None)
    thr = max(filters.threshold_otsu(yellow), 12)
    mask = yellow > thr
    mask = morphology.remove_small_objects(mask, 4000)
    mask = ndi.binary_fill_holes(mask)
    lbl = measure.label(mask)
    if lbl.max() == 0:
        return None
    biggest = max(measure.regionprops(lbl), key=lambda p: p.area)
    roi = lbl == biggest.label
    roi = ndi.binary_fill_holes(roi)
    # Pull in from the rim (meniscus + dish wall create bright artefacts).
    roi = morphology.binary_erosion(roi, morphology.disk(RIM_ERODE))
    return roi


def count_colonies(rgb: np.ndarray, roi: np.ndarray):
    """Return (count, label_image, regionprops_kept) for colonies inside roi.

    Colonies are small, round, locally-bright spots. We flatten the amber-agar
    background with a gaussian, exclude specular glare (bright + unsaturated),
    then keep only signal that rises K*sigma above the in-dish background — so a
    clean plate scores ~0 rather than lighting up on agar mottling.
    """
    gray = color.rgb2gray(rgb)
    bg = filters.gaussian(gray, sigma=BG_SIGMA, preserve_range=True)
    flat = gray - bg

    # Exclude specular glare / white paper: very high value in HSV.
    value = color.rgb2hsv(rgb)[..., 2]
    glare = morphology.binary_dilation(value > GLARE_V, morphology.disk(GLARE_DILATE))
    valid = roi & ~glare
    v = flat[valid]
    if v.size < 500:
        return 0, np.zeros_like(gray, int), []

    thr = max(float(v.mean() + THRESH_K * v.std()), ABS_FLOOR)
    bw = (flat > thr) & valid
    bw = morphology.remove_small_objects(bw, AREA_MIN)
    if not bw.any():
        return 0, np.zeros_like(gray, int), []

    # Split touching colonies via watershed on the distance transform.
    dist = ndi.distance_transform_edt(bw)
    peaks = feature.peak_local_max(
        dist, min_distance=MARKER_MIN_DIST, labels=bw, exclude_border=False,
    )
    markers = np.zeros(dist.shape, int)
    for i, (r, c) in enumerate(peaks, start=1):
        markers[r, c] = i
    labels = segmentation.watershed(-dist, markers, mask=bw)

    kept = [
        p for p in measure.regionprops(labels)
        if AREA_MIN <= p.area <= AREA_MAX and p.eccentricity <= ECC_MAX
    ]
    return len(kept), labels, kept


def analyze(path: Path):
    rgb = to_work(load_rgb(path))
    roi = find_agar_roi(rgb)
    if roi is None or roi.sum() < 2000:
        return dict(count=None, rgb=rgb, roi=None, kept=[])
    count, _labels, kept = count_colonies(rgb, roi)
    return dict(count=count, rgb=rgb, roi=roi, kept=kept)


# ── Labels ──────────────────────────────────────────────────────────────────────

RESERVED = {
    "neg": "Neg control", "negative": "Neg control", "neg-ctrl": "Neg control",
    "pos": "Positive control", "positive": "Positive control", "pos-ctrl": "Positive control",
}


def display_label(raw: str) -> str:
    return RESERVED.get(raw.lower(), raw)


def effective(r) -> object:
    """Hand-set override if given, else the automatic count."""
    ov = r.get("override")
    return ov if ov is not None else r["count"]


def build_label_map(image_paths, map_arg, folder: Path) -> dict:
    if map_arg:
        pairs = [kv.split("=", 1) for kv in map_arg.split(",") if "=" in kv]
        return {k.strip(): v.strip() for k, v in pairs}
    plates_txt = folder / "plates.txt"
    if plates_txt.exists():
        m = {}
        for line in plates_txt.read_text().splitlines():
            if "=" in line and not line.strip().startswith("#"):
                k, v = line.split("=", 1)
                m[k.strip()] = v.strip()
        return m
    return {p.stem: p.stem for p in image_paths}


# ── Montage ─────────────────────────────────────────────────────────────────────

def save_montage(results, exp: str, day: int) -> Path:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from plot_style import apply_style, C  # noqa: E402
    apply_style()

    n = len(results)
    ncol = min(n, 3)
    nrow = int(np.ceil(n / ncol))
    fig, axes = plt.subplots(nrow, ncol, figsize=(4.2 * ncol, 4.4 * nrow), squeeze=False)
    for ax in axes.ravel():
        ax.axis("off")

    for ax, r in zip(axes.ravel(), results):
        ax.imshow(r["rgb"])
        if r["roi"] is not None:
            # dish outline
            contours = measure.find_contours(r["roi"].astype(float), 0.5)
            for ct in contours[:1]:
                ax.plot(ct[:, 1], ct[:, 0], color=C["blue"], lw=1.0, alpha=0.6)
            for p in r["kept"]:
                cy, cx = p.centroid
                ax.add_patch(plt.Circle((cx, cy), 6, fill=False,
                                        edgecolor=C["pink"], lw=0.7))
        eff = effective(r)
        cnt = "—" if eff is None else eff
        tag = "  (set)" if r.get("override") is not None else ""
        ax.set_title(f"{r['display']}\nn = {cnt}{tag}", fontsize=10)

    fig.suptitle(f"{exp} Day {day} — colony counts (auto)", fontweight="bold")
    fig.tight_layout(rect=(0, 0, 1, 0.97))

    out_dir = FIGURES_DIR / exp.replace("_", "")
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / f"{exp.replace('_', '')}_day{day}_colony-counts.png"
    fig.savefig(out, dpi=200)
    plt.close(fig)
    return out


# ── Day-file update ───────────────────────────────────────────────────────────

START = "<!-- colony-counts:start -->"
END = "<!-- colony-counts:end -->"


def find_day_file(exp: str, day: int) -> Path | None:
    folders = list(EXPERIMENTS_DIR.glob(f"{exp}_*"))
    for folder in folders:
        for f in folder.glob(f"{exp}_day{day}_*.md"):
            return f
    return None


def build_block(results, montage: Path) -> str:
    try:
        rel = montage.relative_to(VAULT_ROOT)
    except ValueError:
        rel = montage
    lines = [
        START,
        "### Colony Counts (auto-counted)",
        f"*Counted {date.today().isoformat()} by `count_colonies.py`. Estimates — verify against the montage.*",
        "",
        "| Plate | Colony count | Notes |",
        "|-------|--------------|-------|",
    ]
    for r in results:
        eff = effective(r)
        cnt = "—" if eff is None else eff
        if r.get("override") is not None:
            auto = "dish not detected" if r["count"] is None else f"{r['count']}"
            note = f"confirmed by eye (auto detector reported {auto} — artifacts)"
        elif r["count"] is None:
            note = "dish not detected"
        else:
            note = ""
        lines.append(f"| {r['display']} | {cnt} | {note} |")
    lines += ["", f"![[{rel}]]", END]
    return "\n".join(lines)


def update_day_file(day_file: Path, block: str):
    text = day_file.read_text()
    if START in text and END in text:
        text = re.sub(re.escape(START) + r".*?" + re.escape(END), block, text, flags=re.DOTALL)
    else:
        anchor = "## Data Collected"
        if anchor in text:
            idx = text.index(anchor)
            nl = text.index("\n", idx) + 1
            text = text[:nl] + "\n" + block + "\n" + text[nl:]
        else:
            text = text.rstrip() + "\n\n## Colony Counts\n\n" + block + "\n"
    day_file.write_text(text)


# ── Main ────────────────────────────────────────────────────────────────────────

IMG_EXT = {".heic", ".heif", ".jpg", ".jpeg", ".png", ".tif", ".tiff"}


def main():
    ap = argparse.ArgumentParser(description="Auto-count colonies from plate photos.")
    ap.add_argument("path", help="Image file or a folder of plate photos")
    ap.add_argument("--exp", required=True, help="Experiment id, e.g. TC_001")
    ap.add_argument("--day", type=int, required=True, help="Day number")
    ap.add_argument("--map", default="", help="IMGSTEM=LABEL,IMGSTEM=LABEL ...")
    ap.add_argument("--set", default="", dest="overrides",
                    help="Force a hand-confirmed count, e.g. 'neg=0,pos=lawn'. "
                         "Matched on the plate's label. Overrides the auto count.")
    ap.add_argument("--dry-run", action="store_true", help="Count only; do not edit notes")
    args = ap.parse_args()

    overrides = {}
    for kv in args.overrides.split(","):
        if "=" in kv:
            k, val = kv.split("=", 1)
            overrides[k.strip().lower()] = val.strip()

    src = Path(args.path).expanduser()
    if src.is_dir():
        images = sorted(p for p in src.iterdir()
                        if p.suffix.lower() in IMG_EXT and not p.name.startswith("."))
        folder = src
    else:
        images = [src]
        folder = src.parent
    if not images:
        sys.exit(f"No images found in {src}")

    label_map = build_label_map(images, args.map, folder)

    results = []
    print(f"\nCounting {len(images)} plate(s) for {args.exp} Day {args.day}:\n")
    for p in images:
        raw = label_map.get(p.stem, p.stem)
        r = analyze(p)
        r["display"] = display_label(raw)
        r["raw"] = raw
        r["file"] = p.name
        # Hand-confirmed override (matched on raw label). Trumps the auto count.
        ov = overrides.get(raw.lower())
        r["override"] = ov
        if ov is not None:
            r["kept"] = []  # don't draw auto circles on a manually-set plate
        results.append(r)
        auto = "dish not found" if r["count"] is None else f"{r['count']:>4} auto"
        if ov is not None:
            print(f"  {p.name:<20} {r['display']:<18} {ov:>6} (set)   [{auto.strip()}]")
        else:
            print(f"  {p.name:<20} {r['display']:<18} {auto}")

    # Summary stats for construct plates only (numeric counts).
    construct = []
    for r in results:
        if r["raw"].lower() in RESERVED:
            continue
        eff = effective(r)
        if isinstance(eff, (int, float)):
            construct.append(eff)
    if construct:
        arr = np.array(construct)
        print(f"\n  Constructs: n={len(arr)}  mean={arr.mean():.0f}  "
              f"min={arr.min():.0f}  max={arr.max():.0f}")
    neg = next((r for r in results if r["raw"].lower() in ("neg", "negative", "neg-ctrl")), None)
    if neg and effective(neg) is not None:
        if neg.get("override") is not None:
            print(f"  Neg control: {effective(neg)} (hand-confirmed)")
        else:
            print(f"  Neg control: {neg['count']} (treat as imaging background / blank — "
                  f"verify against montage; reflections can inflate this)")

    montage = save_montage(results, args.exp, args.day)
    print(f"\n  Montage → {montage.relative_to(VAULT_ROOT)}")

    if args.dry_run:
        print("\n  --dry-run: notes not modified.")
        return

    day_file = find_day_file(args.exp, args.day)
    if not day_file:
        print(f"\n  ⚠️  No day file found for {args.exp} day {args.day}; skipping note update.")
    else:
        update_day_file(day_file, build_block(results, montage))
        print(f"  Updated → {day_file.name}")

    sidecar = montage.with_suffix(".json")
    sidecar.write_text(json.dumps(
        [{"file": r["file"], "label": r["display"],
          "count": effective(r), "auto_count": r["count"],
          "override": r.get("override")} for r in results],
        indent=2,
    ))
    print(f"  Data   → {sidecar.relative_to(VAULT_ROOT)}\n")


if __name__ == "__main__":
    main()
