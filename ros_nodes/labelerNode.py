#!/usr/bin/env python3
"""
Labeler node — acha os objetos de cada foto com o OWLv2 e grava um dataset de detecção (COCO).

Tópicos:
  SUB  <camera_topic>                   sensor_msgs/Image
  SUB  /fbot_webclient/labeler/request  std_msgs/String  (JSON)
  PUB  /fbot_webclient/labeler/response std_msgs/String  (JSON)

Protocolo JSON (request):
  { "action": "detect",          "request_id": "<str>" }
  { "action": "stage",           "split": "train"|"valid", "objects": [<object>, ...], "request_id": "<str>" }
  { "action": "discard",         "request_id": "<str>" }
  { "action": "save",            "ids": ["<str>", ...] }
  { "action": "gallery_list",    "offset": <int> }
  { "action": "discard_unsaved" }

Protocolo JSON (response):
  { "action": "detect", "success": true, "objects": [<object>, ...], "classes": ["<str>", ...],
    "width": <px>, "height": <px>, "frame": "data:image/jpeg;base64,...", "request_id": "<str>" }
  { "action": "detect", "success": false, "error": "<str>", "request_id": "<str>" }
  { "action": "stage",    "success": true,  "item": <item>,   "request_id": "<str>" }
  { "action": "stage",    "success": false, "error": "<str>", "request_id": "<str>" }
  { "action": "save",     "success": <bool>,
    "saved":  [{"id": "<str>", "new_id": "<str>", "path": "<str>"}],
    "errors": [{"id": "<str>", "error": "<str>"}] }
  { "action": "gallery_list",    "success": true, "items": [<item>, ...], "offset": <int>, "total": <int> }
  { "action": "discard_unsaved", "success": true }

  <object> = { "label": "<str>", "box": [x0, y0, x1, y1], "confidence": <0–1> }
             (box normalizada pela largura e altura do frame; o detect manda a confiança, o stage não)
  <item>   = { "id": "<str>", "labels": ["<str>", ...], "split": "<str>", "saved": <bool>,
               "time": <ms>, "thumb": "data:image/jpeg;base64,..." }

Fluxo: "detect" trava o frame e devolve as caixas que o OWLv2 achou para as classes
conhecidas; a página deixa trocar a classe, apagar e desenhar caixas; "stage" (botão
Confirm) guarda o frame com as caixas revisadas como captura pendente, só em memória, e
só aceita o request_id do detect que travou aquele frame; "save" grava as pendentes
escolhidas no dataset. O que não foi salvo some quando o node reinicia.

Dataset: o formato COCO do Roboflow, por split:
  {datasets_path}/{split}/{timestamp}.jpg
  {datasets_path}/{split}/_annotations.coco.json
Classes conhecidas = parâmetro "classes" + as que já têm caixa no dataset, então uma classe
nova digitada na revisão passa a ser procurada na próxima foto.

O campo "frame" é um JPEG reduzido do frame realmente capturado — a página desenha as
caixas em cima dele, então a prévia é sempre o que vai ser salvo.
"""

import base64
import io
import json
import os
import re
import threading
import time

import numpy as np
import rclpy
from rclpy.node import Node
from sensor_msgs.msg import Image
from std_msgs.msg import String

try:
    import torch
    import torchvision
    from PIL import Image as PILImage
    from PIL import ImageDraw
    from transformers import Owlv2ForObjectDetection, Owlv2Processor
    _HAS_DETECTOR_DEPS = True
except ImportError:
    _HAS_DETECTOR_DEPS = False

SPLITS = ("train", "valid")
ANNOTATIONS_FILE = "_annotations.coco.json"
GALLERY_PAGE_SIZE = 24
# Nome das fotos gravadas pelo labeler ({timestamp em ms}.jpg) — é o que as
# distingue de imagens que entraram no dataset por outros meios (ex.: export do Roboflow).
CAPTURE_NAME = re.compile(r"\d+\.jpg")
BOX_COLOR = "#fe5000"


# ── Detector ─────────────────────────────────────────────────────────────────

class OwlDetector:
    """OWLv2 (vocabulário aberto): acha as caixas das classes pelo nome, sem treino."""

    PROMPT = "a photo of a {}"
    THRESHOLD = 0.2
    NMS_IOU = 0.5   # caixas quase iguais com classes diferentes viram uma só, a de maior score

    def __init__(self, model_name: str):
        if not _HAS_DETECTOR_DEPS:
            raise RuntimeError(
                "torch, torchvision e transformers são necessários: pip install torch torchvision transformers Pillow"
            )
        self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        self.processor = Owlv2Processor.from_pretrained(model_name)
        self.model = Owlv2ForObjectDetection.from_pretrained(model_name).to(self.device)
        self.model.eval()
        # transformers 5 renomeou o pós-processamento; o 4.x só tem o nome antigo.
        self._post_process = (getattr(self.processor, "post_process_grounded_object_detection", None)
                              or self.processor.post_process_object_detection)

    def detect(self, pil_image, classes: list[str]) -> list[dict]:
        """Returns [{label, confidence, box}] with the box normalized to the image size."""
        if not classes:
            return []
        inputs = self.processor(text=[[self.PROMPT.format(c) for c in classes]], images=pil_image,
                                return_tensors="pt").to(self.device)
        with torch.no_grad():
            outputs = self.model(**inputs)

        # O OWLv2 completa a imagem até um quadrado (embaixo e à direita): o lado maior
        # devolve as caixas em pixels da imagem original.
        side = max(pil_image.size)
        result = self._post_process(outputs, threshold=self.THRESHOLD,
                                    target_sizes=torch.tensor([[side, side]], device=self.device))[0]
        keep = torchvision.ops.nms(result["boxes"], result["scores"], self.NMS_IOU)

        width, height = pil_image.size
        objects = []
        for i in keep.tolist():
            x0, y0, x1, y1 = result["boxes"][i].tolist()
            box = [max(0.0, x0 / width), max(0.0, y0 / height), min(1.0, x1 / width), min(1.0, y1 / height)]
            if box[2] > box[0] and box[3] > box[1]:
                objects.append({"label": classes[int(result["labels"][i])],
                                "confidence": float(result["scores"][i]), "box": box})
        return objects


def _parse_objects(raw) -> list[dict]:
    """Valida os objetos vindos da página: classe não vazia e caixa normalizada não vazia."""
    if not isinstance(raw, list):
        raise ValueError("Campo 'objects' ausente")
    objects = []
    for obj in raw:
        label = str(obj.get("label", "")).strip()
        if not label:
            raise ValueError("Objeto sem classe")
        box = [float(v) for v in obj.get("box", [])]
        if len(box) != 4 or not (0.0 <= box[0] < box[2] <= 1.0 and 0.0 <= box[1] < box[3] <= 1.0):
            raise ValueError(f"Caixa inválida para '{label}'")
        objects.append({"label": label, "box": box})
    return objects


def _thumbnail_jpeg(pil_image, max_size: int, quality: int, objects=()) -> bytes:
    thumb = pil_image.convert("RGB")
    thumb.thumbnail((max_size, max_size))
    draw = ImageDraw.Draw(thumb)
    for obj in objects:
        x0, y0, x1, y1 = obj["box"]
        draw.rectangle([x0 * thumb.width, y0 * thumb.height, x1 * thumb.width, y1 * thumb.height],
                       outline=BOX_COLOR, width=2)
    buf = io.BytesIO()
    thumb.save(buf, "JPEG", quality=quality)
    return buf.getvalue()


def _jpeg_data_url(jpeg: bytes) -> str:
    return "data:image/jpeg;base64," + base64.b64encode(jpeg).decode("ascii")


def _frame_to_data_url(pil_image, max_size: int = 960, quality: int = 80) -> str:
    """JPEG reduzido do frame capturado, para a página revisar as caixas em cima dele —
    960 px porque objeto pequeno some numa prévia menor."""
    return _jpeg_data_url(_thumbnail_jpeg(pil_image, max_size, quality))


# ── Dataset ──────────────────────────────────────────────────────────────────

class Dataset:
    """
    O dataset COCO em disco mais as capturas confirmadas que ainda não foram salvas
    (só em memória). A galeria do webclient lista as fotos do labeler já salvas
    ({timestamp}.jpg) e as pendentes; salvar grava a foto e as caixas no split.
    """

    THUMB_SIZE = 240
    THUMB_QUALITY = 75

    def __init__(self, datasets_path: str):
        self._path = datasets_path
        self._pending = []   # [{id, split, time, frame, objects, thumb}], oldest first
        self._thumbs = {}    # (path, mtime) → JPEG bytes

    def _coco_path(self, split: str) -> str:
        return os.path.join(self._path, split, ANNOTATIONS_FILE)

    def _load(self, split: str) -> dict:
        try:
            with open(self._coco_path(split)) as f:
                return json.load(f)
        except FileNotFoundError:
            return {"images": [], "annotations": [], "categories": []}

    def _write(self, split: str, coco: dict):
        # Grava num temporário e troca: um crash no meio não corrompe as anotações já salvas.
        path = self._coco_path(split)
        with open(path + ".tmp", "w") as f:
            json.dump(coco, f)
        os.replace(path + ".tmp", path)

    def classes(self) -> list[str]:
        """Categorias com pelo menos uma caixa no dataset (deixa de fora a superclasse do Roboflow)."""
        names = []
        for split in SPLITS:
            coco = self._load(split)
            used = {a["category_id"] for a in coco["annotations"]}
            names += [c["name"] for c in coco["categories"] if c["id"] in used and c["name"] not in names]
        return names

    def _saved_entries(self) -> list[dict]:
        entries = []
        for split in SPLITS:
            coco = self._load(split)
            names = {c["id"]: c["name"] for c in coco["categories"]}
            boxes = {}
            for a in coco["annotations"]:
                boxes.setdefault(a["image_id"], []).append((names[a["category_id"]], a["bbox"]))
            for img in coco["images"]:
                path = os.path.join(self._path, split, img["file_name"])
                if not CAPTURE_NAME.fullmatch(img["file_name"]) or not os.path.isfile(path):
                    continue
                w, h = img["width"], img["height"]
                objects = [{"label": label, "box": [x / w, y / h, (x + bw) / w, (y + bh) / h]}
                           for label, (x, y, bw, bh) in boxes.get(img["id"], [])]
                entries.append({"id": f"{split}/{img['file_name']}", "split": split, "path": path,
                                "time": int(img["file_name"][:-4]), "objects": objects})
        entries.sort(key=lambda e: (e["time"], e["id"]))
        return entries

    def _saved_thumb(self, entry: dict) -> bytes:
        key = (entry["path"], os.path.getmtime(entry["path"]))
        if key not in self._thumbs:
            with PILImage.open(entry["path"]) as img:
                self._thumbs[key] = _thumbnail_jpeg(img, self.THUMB_SIZE, self.THUMB_QUALITY, entry["objects"])
        return self._thumbs[key]

    def _public(self, entry: dict) -> dict:
        saved = "frame" not in entry
        thumb = self._saved_thumb(entry) if saved else entry["thumb"]
        return {"id": entry["id"], "labels": [o["label"] for o in entry["objects"]], "split": entry["split"],
                "saved": saved, "time": entry["time"], "thumb": _jpeg_data_url(thumb)}

    def add(self, frame, objects: list[dict], split: str) -> dict:
        now = int(time.time() * 1000)
        if self._pending:
            now = max(now, self._pending[-1]["time"] + 1)
        entry = {"id": f"pending:{now}", "split": split, "time": now, "frame": frame, "objects": objects,
                 "thumb": _thumbnail_jpeg(frame, self.THUMB_SIZE, self.THUMB_QUALITY, objects)}
        self._pending.append(entry)
        return self._public(entry)

    def page(self, offset: int, limit: int = GALLERY_PAGE_SIZE) -> tuple[list[dict], int]:
        """Returns (items, total): saved images oldest first, then the pending ones."""
        entries = self._saved_entries() + self._pending
        items = []
        for entry in entries[offset:offset + limit]:
            try:
                items.append(self._public(entry))
            except Exception:
                continue   # unreadable image file — leave it out of the gallery
        return items, len(entries)

    def save(self, ids: list) -> tuple[list[dict], list[dict]]:
        """Writes the given pending captures to the dataset. Returns (saved, errors)."""
        saved, errors = [], []
        for item_id in ids:
            entry = next((e for e in self._pending if e["id"] == item_id), None)
            try:
                if entry is None:
                    raise ValueError("Captura pendente não encontrada")
                split, frame = entry["split"], entry["frame"]
                os.makedirs(os.path.join(self._path, split), exist_ok=True)
                name = f"{entry['time']}.jpg"
                path = os.path.join(self._path, split, name)
                frame.save(path, "JPEG", quality=95)

                coco = self._load(split)
                image_id = max((i["id"] for i in coco["images"]), default=0) + 1
                coco["images"].append({"id": image_id, "file_name": name, "width": frame.width, "height": frame.height})
                annotation_id = max((a["id"] for a in coco["annotations"]), default=0)
                for obj in entry["objects"]:
                    x0, y0, x1, y1 = obj["box"]
                    bbox = [round(x0 * frame.width, 2), round(y0 * frame.height, 2),
                            round((x1 - x0) * frame.width, 2), round((y1 - y0) * frame.height, 2)]
                    annotation_id += 1
                    coco["annotations"].append({"id": annotation_id, "image_id": image_id,
                                                "category_id": _category_id(coco, obj["label"]), "bbox": bbox,
                                                "area": round(bbox[2] * bbox[3], 2), "segmentation": [], "iscrowd": 0})
                self._write(split, coco)

                self._pending.remove(entry)
                saved.append({"id": item_id, "path": path, "new_id": f"{split}/{name}"})
            except Exception as exc:
                errors.append({"id": item_id, "error": str(exc)})
        return saved, errors

    def discard_pending(self):
        self._pending = []


def _category_id(coco: dict, name: str) -> int:
    """Id da categoria com esse nome; cria a categoria se ainda não existe."""
    for category in coco["categories"]:
        if category["name"] == name:
            return category["id"]
    category_id = max((c["id"] for c in coco["categories"]), default=0) + 1
    coco["categories"].append({"id": category_id, "name": name, "supercategory": "object"})
    return category_id


# ── Node ─────────────────────────────────────────────────────────────────────

class LabelerNode(Node):
    def __init__(self):
        super().__init__("labeler_node")

        # Parâmetros (ros_nodes/labeler_params.yaml, passado pelo start.sh)
        self.declare_parameter("classes", ["cup", "mug", "bottle"])
        self.declare_parameter("datasets_path", os.path.expanduser("~/datasets"))
        self.declare_parameter("detector_model", "google/owlv2-base-patch16-ensemble")
        self.declare_parameter("camera_topic", "/camera/color/image_raw")

        self._configured_classes = list(self.get_parameter("classes").value)
        datasets_path  = self.get_parameter("datasets_path").value
        detector_model = self.get_parameter("detector_model").value
        camera_topic   = self.get_parameter("camera_topic").value

        self._lock         = threading.Lock()
        self._latest_frame = None   # PIL Image — atualizado a cada frame
        self._captured     = None   # (request_id, PIL Image) — travado no detect, liberado no stage/discard
        self._dataset      = Dataset(os.path.expanduser(datasets_path))

        self.get_logger().info(f"Carregando detector '{detector_model}'...")
        try:
            self._detector = OwlDetector(detector_model)
            self.get_logger().info(f"Detector pronto ({self._detector.device}). Classes: {self._classes()}")
        except Exception as exc:
            self.get_logger().error(f"Falha ao carregar detector: {exc}")
            self._detector = None

        # Interfaces ROS
        self.create_subscription(Image,  camera_topic,                       self._on_image,   10)
        self.create_subscription(String, "/fbot_webclient/labeler/request",  self._on_request, 10)
        self._pub = self.create_publisher(String, "/fbot_webclient/labeler/response", 10)

        self.get_logger().info(f"Labeler node pronto. Ouvindo câmera em '{camera_topic}'.")

    def _classes(self) -> list[str]:
        return self._configured_classes + [c for c in self._dataset.classes() if c not in self._configured_classes]

    # ── Callbacks ────────────────────────────────────────────────────────────

    def _on_image(self, msg: Image):
        try:
            # Sem cv_bridge: o do ROS Humble é compilado com NumPy 1.x e derruba o processo (segfault) com NumPy 2.
            # shortcut: só 8-bit RGB/BGR(A); mono ou 16-bit logam erro a cada frame — ampliar se o labeler usar outra câmera.
            channels = len(msg.data) // (msg.height * msg.width)
            arr = np.frombuffer(msg.data, dtype=np.uint8).reshape(msg.height, msg.step)[:, :msg.width * channels]
            arr = arr.reshape(msg.height, msg.width, channels)[:, :, :3]
            if "bgr" in msg.encoding.lower():
                arr = arr[:, :, ::-1]
            pil_img = PILImage.fromarray(np.ascontiguousarray(arr))

            with self._lock:
                self._latest_frame = pil_img

        except Exception as exc:
            self.get_logger().error(f"Conversão de imagem falhou: {exc}")

    def _on_request(self, msg: String):
        try:
            req = json.loads(msg.data)
        except json.JSONDecodeError:
            self.get_logger().error("JSON inválido no request.")
            return

        action = req.get("action")
        if   action == "detect":          self._handle_detect(req)
        elif action == "stage":           self._handle_stage(req)
        elif action == "save":            self._handle_save(req)
        elif action == "gallery_list":    self._handle_gallery_list(req)
        elif action == "discard_unsaved": self._handle_discard_unsaved(req)
        elif action == "discard":
            with self._lock:
                if self._captured and self._captured[0] == req.get("request_id"):
                    self._captured = None
        else:
            self.get_logger().warn(f"Ação desconhecida: '{action}'")

    # ── Handlers ─────────────────────────────────────────────────────────────

    def _handle_detect(self, req: dict):
        rid = req.get("request_id", "")

        with self._lock:
            if self._latest_frame is None:
                self._respond({"action": "detect", "success": False,
                               "error": "Nenhum frame disponível", "request_id": rid})
                return
            frame = self._latest_frame.copy()
            self._captured = (rid, frame)

        if self._detector is None:
            self._respond({"action": "detect", "success": False,
                           "error": "Detector não carregado", "request_id": rid})
            return

        try:
            classes = self._classes()
            objects = self._detector.detect(frame, classes)
            self.get_logger().info(f"Detectados: {[o['label'] for o in objects]}")
            self._respond({"action": "detect", "success": True, "objects": objects, "classes": classes,
                           "width": frame.width, "height": frame.height,
                           "frame": _frame_to_data_url(frame), "request_id": rid})
        except Exception as exc:
            self.get_logger().error(f"Detecção falhou: {exc}")
            self._respond({"action": "detect", "success": False,
                           "error": str(exc), "request_id": rid})

    def _handle_stage(self, req: dict):
        rid   = req.get("request_id", "")
        split = req.get("split", "train")

        try:
            objects = _parse_objects(req.get("objects"))
        except (ValueError, TypeError, AttributeError) as exc:
            self._respond({"action": "stage", "success": False,
                           "error": str(exc) or "Objetos inválidos", "request_id": rid})
            return
        if split not in SPLITS:
            self._respond({"action": "stage", "success": False,
                           "error": "Split inválido", "request_id": rid})
            return

        # Só o frame travado por este mesmo pedido: uma resposta atrasada não troca a foto.
        with self._lock:
            frame = self._captured[1] if self._captured and self._captured[0] == rid else None
            if frame is not None:
                self._captured = None

        if frame is None:
            self._respond({"action": "stage", "success": False,
                           "error": "Nenhum frame capturado para este pedido", "request_id": rid})
            return

        try:
            item = self._dataset.add(frame, objects, split)
            self.get_logger().info(f"Captura pendente ({split}): {[o['label'] for o in objects]}")
            self._respond({"action": "stage", "success": True,
                           "item": item, "request_id": rid})
        except Exception as exc:
            self.get_logger().error(f"Falha ao guardar captura: {exc}")
            self._respond({"action": "stage", "success": False,
                           "error": str(exc), "request_id": rid})

    def _handle_save(self, req: dict):
        ids = req.get("ids")
        if not isinstance(ids, list):
            self._respond({"action": "save", "success": False, "saved": [],
                           "errors": [{"id": None, "error": "Campo 'ids' ausente"}]})
            return

        try:
            saved, errors = self._dataset.save(ids)
        except Exception as exc:
            self.get_logger().error(f"Salvamento falhou: {exc}")
            self._respond({"action": "save", "success": False, "saved": [],
                           "errors": [{"id": None, "error": str(exc)}]})
            return

        for entry in saved:
            self.get_logger().info(f"Salvo: {entry['path']}")
        for entry in errors:
            self.get_logger().error(f"Salvamento de {entry['id']} falhou: {entry['error']}")
        self._respond({"action": "save", "success": not errors,
                       "saved": saved, "errors": errors})

    def _handle_gallery_list(self, req: dict):
        try:
            offset = max(int(req.get("offset", 0)), 0)
            items, total = self._dataset.page(offset)
            self._respond({"action": "gallery_list", "success": True,
                           "items": items, "offset": offset, "total": total})
        except Exception as exc:
            self.get_logger().error(f"Listagem da galeria falhou: {exc}")
            self._respond({"action": "gallery_list", "success": False, "error": str(exc)})

    def _handle_discard_unsaved(self, req: dict):
        self._dataset.discard_pending()
        self._respond({"action": "discard_unsaved", "success": True})

    # ── Helpers ──────────────────────────────────────────────────────────────

    def _respond(self, data: dict):
        msg = String()
        msg.data = json.dumps(data)
        self._pub.publish(msg)


# ── Entry point ───────────────────────────────────────────────────────────────

def main():
    rclpy.init()
    node = LabelerNode()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == "__main__":
    main()
