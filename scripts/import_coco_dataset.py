#!/usr/bin/env python3
"""
Importa um dataset de detecção em formato COCO (ex.: export do Roboflow) para a
estrutura de pastas do labeler: {datasets_path}/{label}/{split}/{nome}.jpg

Cada caixa anotada vira um recorte. O recorte leva uma margem de contexto em
volta do objeto (--pad) porque o labeler classifica o frame inteiro da câmera,
não um recorte justo.

Uso:
  python3 import_coco_dataset.py <pasta com _annotations.coco.json> [--out ~/datasets]
                                 [--split train] [--pad 1.5] [--min-size 8]
"""

import argparse
import json
import os

from PIL import Image

ANNOTATIONS_FILE = "_annotations.coco.json"


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("coco_dir")
    parser.add_argument("--out", default="~/datasets")
    parser.add_argument("--split", default="train", choices=["train", "valid"])
    parser.add_argument("--pad", type=float, default=1.5, help="margem em volta da caixa, em fração do tamanho dela")
    parser.add_argument("--min-size", type=float, default=8, help="ignora caixas com lado menor que isso (px)")
    args = parser.parse_args()

    out_dir = os.path.expanduser(args.out)
    with open(os.path.join(args.coco_dir, ANNOTATIONS_FILE)) as f:
        coco = json.load(f)

    categories = {c["id"]: c["name"] for c in coco["categories"]}
    images = {i["id"]: i["file_name"] for i in coco["images"]}

    saved, skipped = {}, 0
    for ann in coco["annotations"]:
        x, y, w, h = ann["bbox"]
        if w < args.min_size or h < args.min_size:
            skipped += 1
            continue

        label = categories[ann["category_id"]]
        file_name = images[ann["image_id"]]
        image = Image.open(os.path.join(args.coco_dir, file_name)).convert("RGB")
        pad_x, pad_y = w * args.pad, h * args.pad
        crop = image.crop((
            max(0, x - pad_x), max(0, y - pad_y),
            min(image.width, x + w + pad_x), min(image.height, y + h + pad_y),
        ))

        save_dir = os.path.join(out_dir, label, args.split)
        os.makedirs(save_dir, exist_ok=True)
        stem = os.path.splitext(file_name)[0]
        crop.save(os.path.join(save_dir, f"{stem}_{ann['id']}.jpg"), "JPEG", quality=95)
        saved[label] = saved.get(label, 0) + 1

    for label in sorted(saved):
        print(f"{label:20s} {saved[label]}")
    print(f"Total: {sum(saved.values())} recortes em {out_dir} ({skipped} caixas pequenas demais ignoradas)")


if __name__ == "__main__":
    main()
