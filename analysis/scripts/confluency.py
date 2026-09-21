#!/usr/bin/env python3
"""
confluency.py — Estimate cell-culture confluency from a microscope image and
save an annotated overlay into the vault (for embedding in day files / culture logs).

Designed for phone-through-eyepiece (afocal) brightfield photos: a bright circular
field of view on a black surround, with center glare + edge vignette. The pipeline:
  1. Detect the circular field of view (FOV); erode the rim.
  2. Flat-field correct (divide by a heavy Gaussian) to remove glare/vignette.
  3. Segment cells by local texture energy (cells are textured; bare substrate is smooth).
  4. Confluency = cell-covered area / FOV area.
  5. Save a side-by-side raw|overlay montage into data/culture-images/<line>/.

Usage
-----
    python3 confluency.py "IMG.heic" --line 293T --date 2026-07-15
    python3 confluency.py img1.png img2.png --line 293T          # averages multiple fields
    python3 confluency.py "IMG.png" --line 293T --note reagents/293T.md   # also append to a note

HEIC is auto-converted via macOS `sips`. Stack: numpy + scipy + skimage + matplotlib + PIL.

Confluency from afocal phone photos is an ESTIMATE — always eyeball the saved overlay.
"""
import argparse
import subprocess
import sys
import tempfile
import re
from datetime import date as _date
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage as ndi
from skimage import filters, morphology, color

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

VAULT_ROOT = Path(__file__).resolve().parents[2]        # scripts/ -> analysis/ -> vault
IMG_DIR = VAULT_ROOT / "data" / "culture-images"

# ── tunables ─────────────────────────────────────────────────────────────────
RIM_KEEP   = 0.90    # fraction of FOV radius kept (erodes bright rim/vignette)
FLAT_SIGMA = 12      # illumination blur = max_dim / FLAT_SIGMA
TEXT_HP    = 3       # high-pass sigma (px) isolating cell edges/texture
TEXT_SMOOTH = 5      # smoothing of texture-energy map (px)
MIN_OBJ    = 40      # remove texture specks smaller than this (px)
CLOSE_FRAC = 110     # closing disk radius = max_dim / CLOSE_FRAC (fills mesh interiors)
HOLE_FRAC  = 900     # fill holes up to (FOV_area / HOLE_FRAC) px (confluent patch interiors)


def load_image(path: Path) -> np.ndarray:
    p = Path(path)
    if p.suffix.lower() in (".heic", ".heif"):
        tmp = Path(tempfile.mkdtemp()) / (p.stem + ".png")
        subprocess.run(["sips", "-s", "format", "png", str(p), "--out", str(tmp)],
                       check=True, capture_output=True)
        p = tmp
    return np.asarray(Image.open(p).convert("RGB"))


def detect_fov(gray: np.ndarray) -> np.ndarray:
    """Circular field-of-view mask (largest bright blob), rim eroded."""
    h, w = gray.shape
    thr = filters.threshold_otsu(gray)
    bright = ndi.binary_fill_holes(gray > thr * 0.5)
    lbl, n = ndi.label(bright)
    if n == 0:
        cy, cx, r = h / 2, w / 2, min(h, w) / 2
    else:
        sizes = ndi.sum(np.ones_like(lbl), lbl, range(1, n + 1))
        comp = lbl == (int(np.argmax(sizes)) + 1)
        ys, xs = np.where(comp)
        cy, cx = ys.mean(), xs.mean()
        r = np.sqrt(comp.sum() / np.pi)
    yy, xx = np.ogrid[:h, :w]
    return (yy - cy) ** 2 + (xx - cx) ** 2 <= (r * RIM_KEEP) ** 2


def compute(img_rgb: np.ndarray):
    gray = color.rgb2gray(img_rgb)
    fov = detect_fov(gray)
    bg = ndi.gaussian_filter(gray, max(gray.shape) / FLAT_SIGMA)
    flat = gray / (bg + 1e-6)
    hp = flat - ndi.gaussian_filter(flat, TEXT_HP)
    energy = ndi.gaussian_filter(np.abs(hp), TEXT_SMOOTH)
    thr = filters.threshold_otsu(energy[fov])
    cells = (energy > thr) & fov
    cells = morphology.remove_small_objects(cells, MIN_OBJ)
    # cell texture is a mesh of edges — close it into filled monolayer regions,
    # then fill interior holes, so coverage reflects area occupied (not just edges)
    rad = max(int(round(max(gray.shape) / CLOSE_FRAC)), 3)
    cells = morphology.binary_closing(cells, morphology.disk(rad))
    cells = morphology.remove_small_holes(cells, int(fov.sum() / HOLE_FRAC))
    cells &= fov
    conf = 100.0 * cells.sum() / fov.sum()
    return conf, fov, cells


def save_overlay(img_rgb, fov, cells, conf, out_png: Path):
    overlay = img_rgb.astype(float).copy()
    overlay[cells] = 0.55 * overlay[cells] + 0.45 * np.array([60, 220, 120])
    ring = fov ^ ndi.binary_erosion(fov, iterations=4)
    overlay[ring] = [255, 210, 0]
    overlay = np.clip(overlay, 0, 255).astype(np.uint8)

    fig, ax = plt.subplots(1, 2, figsize=(13, 6.6))
    ax[0].imshow(img_rgb); ax[0].set_title("Raw"); ax[0].axis("off")
    ax[1].imshow(overlay)
    ax[1].set_title(f"Confluency ≈ {conf:.0f}%  (green = cells, in FOV)")
    ax[1].axis("off")
    fig.tight_layout()
    out_png.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(out_png, dpi=110, bbox_inches="tight")
    plt.close(fig)


def band(conf: float) -> str:
    if conf < 30:   return "sparse"
    if conf < 60:   return "sub-confluent"
    if conf < 80:   return "approaching confluence"
    if conf < 95:   return "near-confluent (split/plate range)"
    return "confluent — split now (293T detach at 100%)"


def append_note(note_path: Path, d: str, line: str, conf: float, embed: str):
    """Insert/replace a dated row under a '## Confluency Log' section."""
    text = note_path.read_text()
    row = f"| {d} | {line} | ~{conf:.0f}% | ![[{embed}]] |"
    header = ("## Confluency Log\n\n"
              "| Date | Line | Confluency | Image |\n"
              "|------|------|-----------|-------|\n")
    if "## Confluency Log" not in text:
        text = text.rstrip() + "\n\n" + header + row + "\n"
    else:
        # replace an existing row for same date+line, else append after the table header
        pat = rf"^\|\s*{re.escape(d)}\s*\|\s*{re.escape(line)}\s*\|.*$"
        if re.search(pat, text, re.M):
            text = re.sub(pat, row, text, flags=re.M)
        else:
            text = re.sub(r"(\|------\|------\|-----------\|-------\|\n)",
                          r"\1" + row + "\n", text, count=1)
    note_path.write_text(text)


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("images", nargs="+", help="one or more microscope image files")
    ap.add_argument("--line", required=True, help="cell line, e.g. 293T")
    ap.add_argument("--date", default=str(_date.today()), help="YYYY-MM-DD (default today)")
    ap.add_argument("--note", default=None,
                    help="vault-relative note to append a Confluency Log entry to (e.g. reagents/293T.md)")
    ap.add_argument("--dry-run", action="store_true", help="compute + save overlay, do not touch any note")
    args = ap.parse_args()

    confs = []
    out_png = None
    for i, img_path in enumerate(args.images):
        rgb = load_image(Path(img_path))
        conf, fov, cells = compute(rgb)
        confs.append(conf)
        suffix = f"_{i+1}" if len(args.images) > 1 else ""
        out_png = IMG_DIR / args.line / f"{args.date}_{args.line}_confluency{suffix}.png"
        save_overlay(rgb, fov, cells, conf, out_png)
        print(f"  {Path(img_path).name}: ~{conf:.0f}% confluent  ->  {out_png.relative_to(VAULT_ROOT)}")

    mean = float(np.mean(confs))
    print(f"\n{args.line}  {args.date}:  ~{mean:.0f}% confluent  ({band(mean)})")
    if len(confs) > 1:
        print(f"  fields: {', '.join(f'{c:.0f}%' for c in confs)}")

    if args.note and not args.dry_run:
        note_path = VAULT_ROOT / args.note
        if note_path.exists():
            append_note(note_path, args.date, args.line, mean, out_png.name)
            print(f"  wrote Confluency Log entry -> {args.note}")
        else:
            print(f"  [warn] note not found: {args.note}", file=sys.stderr)

    print("\n⚠️  Estimate from an afocal photo — open the overlay and sanity-check the green mask.")


if __name__ == "__main__":
    main()
