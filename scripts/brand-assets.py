"""Regenerates every Kumora logo, favicon and icon from the two sources in
assets/brand/. Rerun after replacing a source:

    python3 -I scripts/brand-assets.py

Needs Pillow built with libimagequant (Debian/Ubuntu: python3-pil).
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
BRAND = ROOT / "assets" / "brand"
WEB = ROOT / "apps" / "web" / "public"
DASHBOARD = ROOT / "apps" / "dashboard" / "public"

# The rounded tile inside kumora-icon.png. Outside it is a faint halo (alpha < 8)
# that only blurs small sizes.
TILE_BOX = (84, 82, 1174, 1148)
# Inset from the tile edge that drops its glowing frame, leaving the whale art.
ART_INSET = 130
# The tile's navy. Pads the art crop out to a square.
NAVY = (1, 20, 57)
WORDMARK_ALPHA_FLOOR = 8


def square(img: Image.Image, fill=(0, 0, 0, 0)) -> Image.Image:
    side = max(img.size)
    out = Image.new(img.mode, (side, side), fill)
    out.paste(img, ((side - img.width) // 2, (side - img.height) // 2))
    return out


def load_sources():
    icon = Image.open(BRAND / "kumora-icon.png").convert("RGBA")
    framed = icon.crop(TILE_BOX)
    tile = square(framed)
    w, h = framed.size
    art = framed.crop(
        (ART_INSET, ART_INSET - 12, w - ART_INSET, h - ART_INSET + 12)
    )
    art = square(art.convert("RGB"), NAVY)

    wordmark = Image.open(BRAND / "kumora-wordmark.png").convert("RGBA")
    bbox = (
        wordmark.getchannel("A")
        .point(lambda v: 255 if v > WORDMARK_ALPHA_FLOOR else 0)
        .getbbox()
    )
    return tile, art, wordmark.crop(bbox)


def tile_png(tile, size):
    return tile.resize((size, size), Image.LANCZOS)


def bleed_png(art, size):
    """Frameless art edge to edge, for platforms that round the corners."""
    return art.resize((size, size), Image.LANCZOS)


def maskable_png(art, size):
    """Art inside the 80% safe zone over a blurred copy of itself, so any
    launcher mask shape crops background, not whale."""
    out = art.resize((size, size)).filter(ImageFilter.GaussianBlur(size / 8.5))
    inner = int(size * 0.8)
    feather = int(inner * 0.08)
    mask = Image.new("L", (inner, inner), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (feather, feather, inner - feather, inner - feather),
        radius=inner // 4,
        fill=255,
    )
    mask = mask.filter(ImageFilter.GaussianBlur(feather / 2))
    offset = (size - inner) // 2
    out.paste(art.resize((inner, inner), Image.LANCZOS), (offset, offset), mask)
    return out


def wordmark_png(wordmark, width):
    return wordmark.resize(
        (width, round(wordmark.height * width / wordmark.width)), Image.LANCZOS
    )


def og_image(wordmark):
    """1200x630 link preview: the wordmark on a navy radial glow."""
    w, h = 1200, 630
    glow = Image.new("L", (w, h), 0)
    ImageDraw.Draw(glow).ellipse((150, 60, w - 150, h - 60), fill=255)
    glow = glow.filter(ImageFilter.GaussianBlur(140))
    out = Image.composite(
        Image.new("RGB", (w, h), (6, 40, 96)), Image.new("RGB", (w, h), (2, 8, 22)), glow
    )
    mark = wordmark_png(wordmark, 1000)
    out.paste(mark, ((w - mark.width) // 2, (h - mark.height) // 2), mark)
    return out


def save_png(img, path):
    img.convert("RGBA").quantize(256, method=Image.Quantize.LIBIMAGEQUANT).save(
        path, optimize=True
    )


def main():
    tile, art, wordmark = load_sources()

    pwa = {
        "icon-192.png": tile_png(tile, 192),
        "icon-512.png": tile_png(tile, 512),
        "icon-maskable-512.png": maskable_png(art, 512),
        "apple-touch-icon.png": bleed_png(art, 180),
    }
    outputs = {
        **{WEB / name: img for name, img in pwa.items()},
        **{DASHBOARD / name: img for name, img in pwa.items()},
        WEB / "kumora-wordmark.png": wordmark_png(wordmark, 640),
        DASHBOARD / "kumora-mark.png": tile_png(tile, 96),
    }
    for path, img in outputs.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        save_png(img, path)

    for app in (WEB, DASHBOARD):
        tile_png(tile, 256).save(
            app / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)]
        )

    og_image(wordmark).save(
        WEB / "og-image.jpg", quality=86, optimize=True, progressive=True
    )


if __name__ == "__main__":
    main()
