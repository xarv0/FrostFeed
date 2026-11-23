#!/usr/bin/env python3
"""Generate the extension icons (rounded orange tile + archive box glyph)."""
import os
from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "icons")
os.makedirs(OUT, exist_ok=True)

S = 512
ACCENT = (255, 69, 0, 255)
WHITE = (255, 255, 255, 255)


def make(size: int) -> Image.Image:
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # tile
    d.rounded_rectangle([8, 8, S - 8, S - 8], radius=112, fill=ACCENT)

    # lid
    d.rounded_rectangle([96, 128, S - 96, 200], radius=18, fill=WHITE)
    # body
    d.rounded_rectangle([120, 208, S - 120, 400], radius=22, fill=WHITE)
    # handle notch cut out of the body
    d.rounded_rectangle([S // 2 - 54, 268, S // 2 + 54, 306], radius=16, fill=ACCENT)

    return img.resize((size, size), Image.LANCZOS)


for px in (16, 32, 48, 128):
    make(px).save(os.path.join(OUT, f"icon{px}.png"))

print("wrote:", sorted(os.listdir(OUT)))
