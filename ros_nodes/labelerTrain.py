#!/usr/bin/env python3
"""
Treino e rotulagem do Labeler com YOLO de segmentação (ultralytics). O labelerNode.py roda
este script como subprocesso, para o node nunca importar o torch:

  train  --data <export yolov8 do Roboflow>/data.yaml --model yolo11n-seg.pt --project <dir> --name v3 --epochs 50
         treina e grava <project>/<name>/weights/best.pt
  label  --model <best.pt> --images <rodada> --out <dir>
         uma anotação COCO por foto, <out>/<split>/<foto>.json, com os polígonos das máscaras

Os pesos base (ex.: yolo11n-seg.pt) são baixados na primeira vez para a pasta atual:
baixe antes de viajar.
"""

import argparse
import json
from pathlib import Path

import yaml

SPLITS = ("train", "valid")
# Pasta de cada chave do data.yaml num export do Roboflow.
DATA_SPLIT_DIRS = {"train": "train", "val": "valid", "test": "test"}


def absolute_data_yaml(data_yaml: Path) -> Path:
    """O data.yaml do Roboflow aponta para "../train/images", que o ultralytics não acha: grava ao
    lado um data_abs.yaml com caminhos absolutos. Sem fotos de validação, valida no próprio treino."""
    data = yaml.safe_load(data_yaml.read_text())
    root = data_yaml.parent
    for key, folder in DATA_SPLIT_DIRS.items():
        images = root / folder / "images"
        if images.is_dir():
            data[key] = str(images)
        else:
            data.pop(key, None)
    if "train" not in data:
        raise SystemExit(f"{root} não tem train/images: é um export yolov8 do Roboflow?")
    data.setdefault("val", data["train"])
    data.pop("path", None)
    out = root / "data_abs.yaml"
    out.write_text(yaml.safe_dump(data))
    return out


def coco_for_image(file_name: str, width: int, height: int, names: dict, detections) -> dict:
    """Anotação COCO de uma foto. detections: [(class_id, polygon [(x, y), ...] em pixels)]."""
    annotations = []
    for class_id, polygon in detections:
        xs, ys = [p[0] for p in polygon], [p[1] for p in polygon]
        # Área pelo polígono (shoelace), não pela caixa.
        area = abs(sum(xs[i] * ys[i - 1] - xs[i - 1] * ys[i] for i in range(len(polygon)))) / 2
        if area < 1:
            continue  # não é área: menos de 3 pontos, ou uma linha (máscara colada na borda da foto)
        x0, y0 = min(xs), min(ys)
        annotations.append({
            "id": len(annotations) + 1, "image_id": 1, "category_id": int(class_id) + 1, "iscrowd": 0,
            "segmentation": [[round(float(v), 1) for p in polygon for v in p]],
            "bbox": [round(x0, 1), round(y0, 1), round(max(xs) - x0, 1), round(max(ys) - y0, 1)],
            "area": round(area, 1),
        })
    return {
        "images": [{"id": 1, "file_name": file_name, "width": width, "height": height}],
        "categories": [{"id": int(i) + 1, "name": name, "supercategory": "object"} for i, name in sorted(names.items())],
        "annotations": annotations,
    }


def train(args):
    from ultralytics import YOLO

    data = absolute_data_yaml(Path(args.data))
    print(f"Treinando {args.model} em {data} por {args.epochs} épocas", flush=True)
    YOLO(args.model).train(data=str(data), epochs=args.epochs, imgsz=args.imgsz, project=args.project,
                           name=args.name, exist_ok=True, plots=False)
    best = Path(args.project) / args.name / "weights" / "best.pt"
    if not best.is_file():
        raise SystemExit(f"O treino terminou sem {best}")
    print(f"Modelo pronto: {best}", flush=True)


def label(args):
    from ultralytics import YOLO

    model = YOLO(args.model)
    images = Path(args.images)
    out = Path(args.out)
    total = 0
    for split in SPLITS:
        photos = sorted((images / split).glob("*.jpg"))
        (out / split).mkdir(parents=True, exist_ok=True)
        for photo in photos:
            result = model.predict(str(photo), conf=args.conf, imgsz=args.imgsz, retina_masks=True, verbose=False)[0]
            height, width = result.orig_shape
            polygons = result.masks.xy if result.masks is not None else []
            classes = result.boxes.cls.tolist() if result.boxes is not None else []
            coco = coco_for_image(photo.name, width, height, model.names,
                                  [(c, poly.tolist()) for c, poly in zip(classes, polygons)])
            (out / split / f"{photo.name}.json").write_text(json.dumps(coco))
            labels = [model.names[a["category_id"] - 1] for a in coco["annotations"]]
            total += 1
            print(f"{split}/{photo.name}: {', '.join(labels) or 'nada'}", flush=True)
    print(f"Rotuladas {total} fotos em {out}", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("train")
    p.add_argument("--data", required=True)
    p.add_argument("--model", required=True)
    p.add_argument("--project", required=True)
    p.add_argument("--name", required=True)
    p.add_argument("--epochs", type=int, default=50)
    p.add_argument("--imgsz", type=int, default=640)
    p = sub.add_parser("label")
    p.add_argument("--model", required=True)
    p.add_argument("--images", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--conf", type=float, default=0.25)
    p.add_argument("--imgsz", type=int, default=640)
    args = parser.parse_args()
    train(args) if args.command == "train" else label(args)


if __name__ == "__main__":
    main()
