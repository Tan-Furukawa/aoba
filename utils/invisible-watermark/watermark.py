from __future__ import annotations

import argparse
import os
import random
import re
import string
from dataclasses import dataclass
from pathlib import Path

import cv2
from imwatermark import WatermarkDecoder, WatermarkEncoder
from PIL import Image


DEFAULT_OWNER = "Furukawa-Tan"
DEFAULT_RANDOM_LENGTH = 6
DEFAULT_METHOD = "dwtDctSvd"
DEFAULT_JPEG_QUALITY = 90
IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp"}


@dataclass
class TrialResult:
    name: str
    path: Path
    decoded: str | None
    exact: bool
    score: float
    error: str | None = None


def random_token(length: int = DEFAULT_RANDOM_LENGTH) -> str:
    alphabet = string.ascii_uppercase + string.digits
    return "".join(random.choice(alphabet) for _ in range(length))


def created_year(image_path: Path) -> str:
    with Image.open(image_path) as image:
        exif = image.getexif()

    for tag in (36867, 306):  # DateTimeOriginal, DateTime
        value = exif.get(tag)
        if value:
            return str(value)[:4]

    raise ValueError(f"No EXIF creation year found in {image_path}")


def build_watermark(image_path: Path, owner: str, token: str | None) -> str:
    return f"{owner}-{created_year(image_path)}-{token or random_token()}"


def read_bgr(image_path: Path):
    image = cv2.imread(str(image_path), cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError(f"Could not read image: {image_path}")
    return image


def original_exif(source_path: Path) -> bytes | None:
    with Image.open(source_path) as image:
        exif = image.getexif()
        if not exif:
            return None
        return exif.tobytes()


def write_image(
    image_path: Path,
    image,
    source_path: Path | None = None,
    jpeg_quality: int = DEFAULT_JPEG_QUALITY,
) -> None:
    image_path.parent.mkdir(parents=True, exist_ok=True)
    suffix = image_path.suffix.lower()

    if suffix in {".jpg", ".jpeg"}:
        rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
        pil_image = Image.fromarray(rgb)
        save_kwargs = {"quality": jpeg_quality}
        if source_path is not None:
            exif = original_exif(source_path)
            if exif is not None:
                save_kwargs["exif"] = exif
        pil_image.save(image_path, **save_kwargs)
        return

    params = []
    if not cv2.imwrite(str(image_path), image, params):
        raise ValueError(f"Could not write image: {image_path}")


def embed_watermark(
    input_path: Path,
    output_path: Path,
    watermark: str,
    method: str = DEFAULT_METHOD,
    jpeg_quality: int = DEFAULT_JPEG_QUALITY,
) -> None:
    image = read_bgr(input_path)
    encoder = WatermarkEncoder()
    encoder.set_watermark("bytes", watermark.encode("utf-8"))
    encoded = encoder.encode(image, method)
    write_image(output_path, encoded, input_path, jpeg_quality)


def extract_watermark(image_path: Path, length: int, method: str = DEFAULT_METHOD) -> str:
    image = read_bgr(image_path)
    decoder = WatermarkDecoder("bytes", length * 8)
    decoded = decoder.decode(image, method)
    if isinstance(decoded, bytes):
        return decoded.decode("utf-8", errors="replace")
    return bytes(decoded).decode("utf-8", errors="replace")


def watermark_length(owner: str, token_length: int) -> int:
    return len(f"{owner}-2026-{'X' * token_length}".encode("utf-8"))


def watermark_pattern(owner: str, token_length: int) -> re.Pattern[str]:
    escaped_owner = re.escape(owner)
    return re.compile(rf"^{escaped_owner}-\d{{4}}-[A-Z0-9]{{{token_length}}}$")


def has_watermark(image_path: Path, owner: str, token_length: int, method: str) -> tuple[bool, str | None]:
    length = watermark_length(owner, token_length)
    try:
        decoded = extract_watermark(image_path, length, method)
    except Exception:
        return False, None
    return bool(watermark_pattern(owner, token_length).match(decoded)), decoded


def iter_content_images(content_root: Path) -> list[Path]:
    return sorted(
        path
        for path in content_root.rglob("*")
        if path.is_file() and path.suffix.lower() in IMAGE_SUFFIXES
    )


def embed_missing_watermarks(
    content_root: Path,
    owner: str,
    token_length: int,
    method: str,
    dry_run: bool,
    force: bool,
    jpeg_quality: int,
) -> None:
    images = iter_content_images(content_root)
    added = 0
    skipped = 0
    failed = 0

    for image_path in images:
        exists, decoded = has_watermark(image_path, owner, token_length, method)
        if exists and not force:
            skipped += 1
            print(f"skip  {image_path} ({decoded})")
            continue

        temporary_path = image_path.with_name(f".{image_path.name}.watermarking{image_path.suffix}")
        try:
            watermark = build_watermark(image_path, owner, random_token(token_length))
            if dry_run:
                added += 1
                action = "overwrite" if exists else "add"
                print(f"would {action}  {image_path} ({watermark})")
                continue

            embed_watermark(image_path, temporary_path, watermark, method, jpeg_quality)
            os.replace(temporary_path, image_path)
            added += 1
            action = "overwrite" if exists else "add"
            print(f"{action:9} {image_path} ({watermark})")
        except Exception as error:  # noqa: BLE001 - continue through the batch and report all failures.
            failed += 1
            print(f"fail  {image_path} ({error})")
            temporary_path = image_path.with_name(f".{image_path.name}.watermarking{image_path.suffix}")
            if temporary_path.exists():
                temporary_path.unlink()

    print("")
    print(f"images={len(images)} added={added} skipped={skipped} failed={failed}")


def match_score(expected: str, actual: str | None) -> float:
    if actual is None:
        return 0.0
    pairs = zip(expected, actual)
    matches = sum(1 for left, right in pairs if left == right)
    return matches / max(len(expected), len(actual), 1)


def save_jpeg_quality(source, output_path: Path, quality: int) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(output_path), source, [cv2.IMWRITE_JPEG_QUALITY, quality])


def save_resized(source, output_path: Path, scale: float) -> None:
    height, width = source.shape[:2]
    resized = cv2.resize(source, (int(width * scale), int(height * scale)), interpolation=cv2.INTER_AREA)
    restored = cv2.resize(resized, (width, height), interpolation=cv2.INTER_CUBIC)
    write_image(output_path, restored)


def save_center_crop(source, output_path: Path, ratio: float) -> None:
    height, width = source.shape[:2]
    crop_w = int(width * ratio)
    crop_h = int(height * ratio)
    left = (width - crop_w) // 2
    top = (height - crop_h) // 2
    cropped = source[top : top + crop_h, left : left + crop_w]
    restored = cv2.resize(cropped, (width, height), interpolation=cv2.INTER_CUBIC)
    write_image(output_path, restored)


def save_blur(source, output_path: Path) -> None:
    blurred = cv2.GaussianBlur(source, (5, 5), 0)
    write_image(output_path, blurred)


def run_trial(name: str, path: Path, expected: str, length: int, method: str) -> TrialResult:
    try:
        decoded = extract_watermark(path, length, method)
        return TrialResult(
            name=name,
            path=path,
            decoded=decoded,
            exact=decoded == expected,
            score=match_score(expected, decoded),
        )
    except Exception as error:  # noqa: BLE001 - report robustness failures without stopping all trials.
        return TrialResult(name=name, path=path, decoded=None, exact=False, score=0.0, error=str(error))


def run_degradation_tests(input_path: Path, output_dir: Path, owner: str, token: str | None, method: str) -> list[TrialResult]:
    watermark = build_watermark(input_path, owner, token)
    length = len(watermark.encode("utf-8"))
    output_dir.mkdir(parents=True, exist_ok=True)

    watermarked = output_dir / "watermarked.png"
    embed_watermark(input_path, watermarked, watermark, method)
    source = read_bgr(watermarked)

    variants = {
        "watermarked_png": watermarked,
        "jpeg_q95": output_dir / "jpeg_q95.jpg",
        "jpeg_q80": output_dir / "jpeg_q80.jpg",
        "jpeg_q60": output_dir / "jpeg_q60.jpg",
        "resize_75pct": output_dir / "resize_75pct.png",
        "resize_50pct": output_dir / "resize_50pct.png",
        "center_crop_90pct": output_dir / "center_crop_90pct.png",
        "center_crop_75pct": output_dir / "center_crop_75pct.png",
        "gaussian_blur": output_dir / "gaussian_blur.png",
    }

    save_jpeg_quality(source, variants["jpeg_q95"], 95)
    save_jpeg_quality(source, variants["jpeg_q80"], 80)
    save_jpeg_quality(source, variants["jpeg_q60"], 60)
    save_resized(source, variants["resize_75pct"], 0.75)
    save_resized(source, variants["resize_50pct"], 0.50)
    save_center_crop(source, variants["center_crop_90pct"], 0.90)
    save_center_crop(source, variants["center_crop_75pct"], 0.75)
    save_blur(source, variants["gaussian_blur"])

    print(f"watermark: {watermark}")
    print(f"byte length: {length}")
    print(f"bit length: {length * 8}")
    print("")

    results = [run_trial(name, path, watermark, length, method) for name, path in variants.items()]
    for result in results:
        decoded = result.decoded if result.decoded is not None else f"ERROR: {result.error}"
        print(f"{result.name:18} exact={str(result.exact):5} score={result.score:.2f} decoded={decoded}")

    return results


def jpeg_quality(value: str) -> int:
    quality = int(value)
    if quality < 1 or quality > 100:
        raise argparse.ArgumentTypeError("--jpeg-quality must be between 1 and 100.")
    return quality


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Embed and test invisible image watermarks.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    embed = subparsers.add_parser("embed", help="Embed a watermark into an image.")
    embed.add_argument("input", type=Path)
    embed.add_argument("output", type=Path)
    embed.add_argument("--owner", default=DEFAULT_OWNER)
    embed.add_argument("--token")
    embed.add_argument("--watermark")
    embed.add_argument("--method", default=DEFAULT_METHOD)
    embed.add_argument("--jpeg-quality", type=jpeg_quality, default=DEFAULT_JPEG_QUALITY)

    extract = subparsers.add_parser("extract", help="Extract a watermark from an image.")
    extract.add_argument("image", type=Path)
    extract.add_argument("--length", type=int, default=len(f"{DEFAULT_OWNER}-2026-XXXXXX"), help="Watermark byte length.")
    extract.add_argument("--method", default=DEFAULT_METHOD)

    test = subparsers.add_parser("test", help="Run degradation tests against a test image.")
    test.add_argument("--image", type=Path, default=Path("test_img/2026-05-02_09-25-28_110.jpeg"))
    test.add_argument("--output-dir", type=Path, default=Path("out"))
    test.add_argument("--owner", default=DEFAULT_OWNER)
    test.add_argument("--token", default="7FQ92A")
    test.add_argument("--method", default=DEFAULT_METHOD)

    content = subparsers.add_parser("embed-missing", help="Embed missing watermarks into images under a directory.")
    content.add_argument("content_root", type=Path)
    content.add_argument("--owner", default=DEFAULT_OWNER)
    content.add_argument("--token-length", type=int, default=DEFAULT_RANDOM_LENGTH)
    content.add_argument("--method", default=DEFAULT_METHOD)
    content.add_argument("--dry-run", action="store_true")
    content.add_argument("--force", action="store_true", help="Overwrite existing readable watermarks.")
    content.add_argument("--jpeg-quality", type=jpeg_quality, default=DEFAULT_JPEG_QUALITY)

    return parser.parse_args()


def main() -> None:
    args = parse_args()

    if args.command == "embed":
        watermark = args.watermark or build_watermark(args.input, args.owner, args.token)
        embed_watermark(args.input, args.output, watermark, args.method, args.jpeg_quality)
        print(watermark)
    elif args.command == "extract":
        print(extract_watermark(args.image, args.length, args.method))
    elif args.command == "test":
        run_degradation_tests(args.image, args.output_dir, args.owner, args.token, args.method)
    elif args.command == "embed-missing":
        embed_missing_watermarks(
            args.content_root,
            args.owner,
            args.token_length,
            args.method,
            args.dry_run,
            args.force,
            args.jpeg_quality,
        )


if __name__ == "__main__":
    main()
