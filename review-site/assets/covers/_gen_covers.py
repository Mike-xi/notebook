"""Normalize generated course-cover PNGs into compact 1024x576 WebP files.

Requires Pillow (`python -m pip install pillow`). By default this script uses the
built-in image-generation sources created for this set. Pass --source-dir to
use a portable directory containing one `<slug>.png` file per cover instead.
"""

from __future__ import annotations

import argparse
import io
import json
from pathlib import Path

try:
    from PIL import Image
except ImportError as exc:  # pragma: no cover - actionable local setup error
    raise SystemExit("Pillow is required: python -m pip install pillow") from exc


SLUGS = [
    "python", "probability", "physics", "dict", "apple", "osiris",
    "basketball", "cube", "macheng", "g2048", "minesweeper", "pvz2",
    "gomoku", "werewolf", "xiangqi", "majiang", "sichuan-majiang",
    "poker", "noname-cf", "drive", "board", "xipan", "xinote",
]

GENERATED_ROOT = Path(
    r"C:\Users\28205\.codex\generated_images\019f7008-c2bf-7521-aab4-af9eb8eea756"
)

SOURCE_FILES = {
    "python": "exec-32ab5ba7-67f4-4f11-9ad0-b17246ed1af3.png",
    "probability": "exec-960a84a7-a54f-4bfb-b46d-39cbd9ca5bc3.png",
    "physics": "exec-367bb1bf-3214-4eab-9eeb-3fc7be2017b0.png",
    "dict": "exec-471991a7-55be-4f7b-824a-16414e1c8cd2.png",
    "apple": "exec-b3bc8075-d636-47d0-9f05-e6994acf1f2e.png",
    "osiris": "exec-949fbede-5a3b-455e-a0c8-9528609eef0f.png",
    "basketball": "exec-605c2d5a-18e9-454a-a141-704e85f804bf.png",
    "cube": "exec-56779cdd-f9a7-4ee1-ba79-20155e084f47.png",
    "macheng": "exec-6bf367d2-9c60-41b6-8ae0-cd2a61fa5434.png",
    "g2048": "exec-af300056-7202-456c-ad4b-a0759a12f474.png",
    "minesweeper": "exec-f0677f8f-4529-417d-a174-56a396acc706.png",
    "pvz2": "exec-723d63fa-ab43-49f6-8ddf-f6ef921ece1d.png",
    "gomoku": "exec-0e30c446-7331-49cb-a812-48336594d7e8.png",
    "werewolf": "exec-ebf3679e-47d0-4617-b54a-49c383a24581.png",
    "xiangqi": "exec-80c64536-7f8a-4f78-a374-1c22f7b66cc2.png",
    "majiang": "exec-9bc93e80-ad72-4c34-9909-45c1c79d584a.png",
    "sichuan-majiang": "exec-d63a3913-4f26-4517-bd66-ad22aa4d8e22.png",
    "poker": "exec-5010b988-6e61-4624-b828-d8c90cff7422.png",
    "noname-cf": "exec-694e98d5-9f24-4df6-b9a8-675e1ab2c7ec.png",
    "drive": "exec-78777fe4-444a-4713-b0de-276050120c52.png",
    "board": "exec-7e5bfb07-7790-487f-92be-68718758eb06.png",
    "xipan": "exec-96ebc65d-3be3-42be-8d58-53977e5cd27e.png",
    "xinote": "exec-6e588d2e-75a0-46a5-87ed-ae2587162723.png",
}


def cover_crop(image: Image.Image) -> Image.Image:
    """Center-crop to 16:9 and resize with high-quality antialiasing."""
    image = image.convert("RGB")
    width, height = image.size
    target_ratio = 16 / 9
    if width / height > target_ratio:
        crop_width = round(height * target_ratio)
        left = (width - crop_width) // 2
        image = image.crop((left, 0, left + crop_width, height))
    else:
        crop_height = round(width / target_ratio)
        top = (height - crop_height) // 2
        image = image.crop((0, top, width, top + crop_height))
    return image.resize((1024, 576), Image.Resampling.LANCZOS)


def encode_under_limit(image: Image.Image, max_bytes: int = 300_000) -> bytes:
    """Encode near quality 82, lowering quality only when needed."""
    best = b""
    for quality in (82, 80, 78, 76, 74, 72, 70, 68, 66, 64, 62, 60):
        buffer = io.BytesIO()
        image.save(buffer, "WEBP", quality=quality, method=6)
        best = buffer.getvalue()
        if len(best) < max_bytes:
            return best
    return best


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--source-dir",
        type=Path,
        help="Optional directory containing `<slug>.png` source files.",
    )
    parser.add_argument(
        "--output-dir", type=Path, default=Path(__file__).resolve().parent
    )
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)

    generated: list[str] = []
    for slug in SLUGS:
        source = (
            args.source_dir / f"{slug}.png"
            if args.source_dir
            else GENERATED_ROOT / SOURCE_FILES[slug]
        )
        if not source.is_file():
            raise SystemExit(f"Missing source for {slug}: {source}")
        with Image.open(source) as original:
            final = cover_crop(original)
            payload = encode_under_limit(final)
        destination = args.output_dir / f"{slug}.webp"
        destination.write_bytes(payload)
        generated.append(destination.name)
        print(f"{destination.name:24} {len(payload):8} bytes")

    manifest = {
        "generated": generated,
        "method": "imagegen-or-procedural",
    }
    (args.output_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
