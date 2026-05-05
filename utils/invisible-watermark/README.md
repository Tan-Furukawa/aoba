# Invisible Watermark

Embed a byte watermark like `Furukawa-Tan-2026-7FQ92A`.

The year is read from the source image EXIF creation date.

## Setup

```bash
uv sync
```

## Embed

```bash
uv run python watermark.py embed test_img/2026-05-02_09-25-28_110.jpeg out/watermarked.jpeg --token 7FQ92A --jpeg-quality 90
```

## Extract

```bash
uv run python watermark.py extract out/watermarked.png --length 24
```

The example watermark `Furukawa-Tan-2026-7FQ92A` is 24 bytes long, so use `--length 24` for that exact string.

## Degradation Test

```bash
uv run python watermark.py test
```

The test writes edited variants to `out/` and prints whether the watermark can be read after JPEG recompression, resizing, center cropping, and blur. The default method is `dwtDctSvd`; in the current test image it survives moderate JPEG recompression, resizing, and blur, but not aggressive JPEG recompression or center cropping.

## Embed Missing Watermarks Under Content

From the repository root:

```bash
npm run content:watermark-images
```

This scans `content/` images. If a valid watermark like `Furukawa-Tan-2026-7FQ92A` is already readable, the image is skipped. If not, the command embeds a new watermark in place and preserves JPEG EXIF metadata.

Dry run:

```bash
cd utils/invisible-watermark
uv run python watermark.py embed-missing ../../content --dry-run
```

Force overwrite existing readable watermarks:

```bash
npm run content:watermark-images -- --force --jpeg-quality 90
```
