#!/usr/bin/env python3
"""
Labeler node — classifica objetos via CLIP zero-shot e salva frames rotulados.

Tópicos:
  SUB  /camera/color/image_raw          sensor_msgs/Image
  SUB  /fbot_webclient/labeler/request  std_msgs/String  (JSON)
  PUB  /fbot_webclient/labeler/response std_msgs/String  (JSON)

Protocolo JSON (request):
  { "action": "classify",        "request_id": "<str>" }
  { "action": "stage",           "label": "<str>", "split": "train"|"valid", "request_id": "<str>" }
  { "action": "discard",         "request_id": "<str>" }
  { "action": "save",            "ids": ["<str>", ...] }
  { "action": "gallery_list",    "offset": <int> }
  { "action": "discard_unsaved" }

Protocolo JSON (response):
  { "action": "classify", "success": true,  "label": "<str>", "confidence": 0.87,
    "frame": "data:image/jpeg;base64,...", "request_id": "<str>" }
  { "action": "classify", "success": false, "error": "<str>", "request_id": "<str>" }
  { "action": "stage",    "success": true,  "item": <item>,   "request_id": "<str>" }
  { "action": "stage",    "success": false, "error": "<str>", "request_id": "<str>" }
  { "action": "save",     "success": <bool>,
    "saved":  [{"id": "<str>", "new_id": "<str>", "path": "<str>"}],
    "errors": [{"id": "<str>", "error": "<str>"}] }
  { "action": "gallery_list",    "success": true, "items": [<item>, ...], "offset": <int>, "total": <int> }
  { "action": "discard_unsaved", "success": true }

  <item> = { "id": "<str>", "label": "<str>", "split": "<str>", "saved": <bool>,
             "time": <ms>, "thumb": "data:image/jpeg;base64,..." }

Fluxo: "classify" trava o frame; "stage" (botão Confirm) guarda esse frame
como captura pendente, só em memória; "save" grava as pendentes escolhidas no
dataset ({datasets_path}/{label}/{split}/{timestamp}.jpg). A galeria do
webclient ("gallery_list", paginado) são as capturas do labeler já gravadas
no dataset mais as pendentes — então o que foi salvo continua lá entre sessões, e o que não foi
salvo some quando o node reinicia.

O campo "frame" é um thumbnail JPEG (base64) do frame realmente capturado e
classificado — o webclient usa esse frame pra prévia em vez de tentar buscar
um snapshot via HTTP, já que o web_video_server real não expõe um endpoint
de imagem única equivalente ao /snapshot do mock_video_server.py.
"""

import base64
import io
import json
import os
import re
import threading
import time
from abc import ABC, abstractmethod

import numpy as np
import rclpy
from rclpy.node import Node
from sensor_msgs.msg import Image
from std_msgs.msg import String

try:
    from cv_bridge import CvBridge
    _HAS_CV_BRIDGE = True
except ImportError:
    _HAS_CV_BRIDGE = False

try:
    import torch
    from PIL import Image as PILImage
    from transformers import CLIPModel, CLIPProcessor
    _HAS_CLIP = True
except ImportError:
    _HAS_CLIP = False

PROMPT_TEMPLATE = "uma foto de um {}"
SPLITS = ("train", "valid")
GALLERY_PAGE_SIZE = 24
IMAGE_EXTENSIONS = (".jpg", ".jpeg", ".png")
# Nome dos arquivos gravados pelo labeler ({timestamp em ms}.jpg) — é o que os
# distingue de imagens importadas pro dataset por outros meios.
CAPTURE_NAME = re.compile(r"\d+\.jpg")


# ── Classifier interface ──────────────────────────────────────────────────────

class Classifier(ABC):
    @abstractmethod
    def classify(self, pil_image) -> tuple[str, float]:
        """Returns (label, confidence)."""


class ZeroShotCLIPClassifier(Classifier):
    """
    Classifica imagens sem treino usando similaridade texto-imagem do CLIP.
    Para migrar para o pipeline completo (HopfieldEnsemble), substitua esta
    classe por TrainedHopfieldClassifier — a interface é idêntica.
    """

    def __init__(self, class_names: list[str], model_name: str = "openai/clip-vit-base-patch32"):
        if not _HAS_CLIP:
            raise RuntimeError(
                "torch e transformers são necessários: pip install torch transformers Pillow"
            )
        self.class_names = class_names
        self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        self.model = CLIPModel.from_pretrained(model_name).to(self.device)
        self.processor = CLIPProcessor.from_pretrained(model_name)
        self.model.eval()

    def classify(self, pil_image: "PILImage.Image") -> tuple[str, float]:
        inputs = self.processor(
            text=[PROMPT_TEMPLATE.format(c) for c in self.class_names],
            images=pil_image,
            return_tensors="pt",
            padding=True,
        ).to(self.device)

        with torch.no_grad():
            outputs = self.model(**inputs)

        probs = outputs.logits_per_image.softmax(dim=-1)[0]
        best_idx = int(probs.argmax())
        return self.class_names[best_idx], float(probs[best_idx])


class FewShotCLIPClassifier(Classifier):
    """
    Classifica usando as imagens já rotuladas em {datasets_path}/{label}/train/.
    O CLIP só extrai os embeddings; em cima deles é treinada uma camada linear
    (regressão logística), o que leva poucos segundos em CPU. As classes são os
    nomes das pastas, então tudo que for salvo pelo próprio labeler entra no
    treino na próxima vez que o node subir.
    """

    BATCH_SIZE = 32
    WEIGHT_DECAY = 1e-2

    def __init__(self, datasets_path: str, model_name: str = "openai/clip-vit-base-patch32"):
        if not _HAS_CLIP:
            raise RuntimeError(
                "torch e transformers são necessários: pip install torch transformers Pillow"
            )
        samples = self.list_samples(datasets_path)
        self.class_names = sorted({label for _, label in samples})
        if len(self.class_names) < 2:
            raise ValueError(f"Dataset em '{datasets_path}' precisa de pelo menos 2 classes com imagens.")

        self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        self.model = CLIPModel.from_pretrained(model_name).to(self.device)
        self.processor = CLIPProcessor.from_pretrained(model_name)
        self.model.eval()
        self.num_samples = len(samples)

        features = torch.cat([
            self._embed([PILImage.open(path).convert("RGB") for path, _ in samples[i:i + self.BATCH_SIZE]])
            for i in range(0, len(samples), self.BATCH_SIZE)
        ])
        targets = torch.tensor([self.class_names.index(label) for _, label in samples], device=self.device)
        self._weight, self._bias = self._fit(features, targets)

    @classmethod
    def list_samples(cls, datasets_path: str) -> list[tuple[str, str]]:
        """Returns [(image_path, label)] for every image under {label}/train/."""
        samples = []
        if not os.path.isdir(datasets_path):
            return samples
        for label in sorted(os.listdir(datasets_path)):
            train_dir = os.path.join(datasets_path, label, "train")
            if not os.path.isdir(train_dir):
                continue
            for name in sorted(os.listdir(train_dir)):
                if name.lower().endswith(IMAGE_EXTENSIONS):
                    samples.append((os.path.join(train_dir, name), label))
        return samples

    def _embed(self, pil_images: list) -> "torch.Tensor":
        inputs = self.processor(images=pil_images, return_tensors="pt").to(self.device)
        with torch.no_grad():
            features = self.model.get_image_features(**inputs)
        return torch.nn.functional.normalize(features, dim=-1)

    def _logits(self, features: "torch.Tensor", weight: "torch.Tensor", bias: "torch.Tensor") -> "torch.Tensor":
        return self.model.logit_scale.exp().detach() * features @ weight.T + bias

    def _fit(self, features: "torch.Tensor", targets: "torch.Tensor"):
        weight = torch.zeros(len(self.class_names), features.shape[1], device=self.device, requires_grad=True)
        bias = torch.zeros(len(self.class_names), device=self.device, requires_grad=True)
        optimizer = torch.optim.LBFGS([weight, bias], max_iter=200)

        def closure():
            optimizer.zero_grad()
            loss = torch.nn.functional.cross_entropy(self._logits(features, weight, bias), targets)
            loss = loss + self.WEIGHT_DECAY * (weight ** 2).sum()
            loss.backward()
            return loss

        optimizer.step(closure)
        return weight.detach(), bias.detach()

    def classify(self, pil_image: "PILImage.Image") -> tuple[str, float]:
        features = self._embed([pil_image.convert("RGB")])
        probs = self._logits(features, self._weight, self._bias).softmax(dim=-1)[0]
        best_idx = int(probs.argmax())
        return self.class_names[best_idx], float(probs[best_idx])


def _thumbnail_jpeg(pil_image, max_size: int, quality: int) -> bytes:
    thumb = pil_image.copy()
    thumb.thumbnail((max_size, max_size))
    buf = io.BytesIO()
    thumb.save(buf, "JPEG", quality=quality)
    return buf.getvalue()


def _jpeg_data_url(jpeg: bytes) -> str:
    return "data:image/jpeg;base64," + base64.b64encode(jpeg).decode("ascii")


def _frame_to_data_url(pil_image, max_size: int = 480, quality: int = 80) -> str:
    """Downscaled JPEG thumbnail of the captured frame, sent back to the
    webclient so its preview always matches what was actually classified/saved
    — the webclient has no other reliable way to fetch this frame itself,
    since web_video_server exposes no single-shot snapshot endpoint."""
    return _jpeg_data_url(_thumbnail_jpeg(pil_image, max_size, quality))


# ── Gallery ──────────────────────────────────────────────────────────────────

class Gallery:
    """
    O que a galeria do webclient mostra: as capturas do labeler já salvas no
    dataset ({datasets_path}/{label}/{split}/{timestamp}.jpg — imagens
    importadas por outros meios ficam de fora) mais as capturas confirmadas
    que ainda não foram salvas. As pendentes ficam só em memória; salvar grava o frame
    no dataset, e a partir daí ele é listado direto do disco.
    """

    THUMB_SIZE = 240
    THUMB_QUALITY = 75

    def __init__(self, datasets_path: str):
        self._datasets_path = datasets_path
        self._pending = []   # [{id, label, split, time, frame, thumb}], oldest first
        self._thumbs = {}    # (path, mtime) → JPEG bytes

    def _saved_entries(self) -> list[dict]:
        entries = []
        if not os.path.isdir(self._datasets_path):
            return entries
        for label in os.listdir(self._datasets_path):
            if label.startswith("."):
                continue
            for split in SPLITS:
                split_dir = os.path.join(self._datasets_path, label, split)
                if not os.path.isdir(split_dir):
                    continue
                for name in os.listdir(split_dir):
                    if CAPTURE_NAME.fullmatch(name):
                        path = os.path.join(split_dir, name)
                        entries.append({"id": f"{label}/{split}/{name}", "label": label, "split": split,
                                        "time": int(os.path.getmtime(path) * 1000), "path": path})
        entries.sort(key=lambda e: (e["time"], e["id"]))
        return entries

    def _saved_thumb(self, entry: dict) -> bytes:
        key = (entry["path"], entry["time"])
        if key not in self._thumbs:
            with PILImage.open(entry["path"]) as img:
                self._thumbs[key] = _thumbnail_jpeg(img.convert("RGB"), self.THUMB_SIZE, self.THUMB_QUALITY)
        return self._thumbs[key]

    def _public(self, entry: dict) -> dict:
        saved = "frame" not in entry
        thumb = self._saved_thumb(entry) if saved else entry["thumb"]
        return {"id": entry["id"], "label": entry["label"], "split": entry["split"],
                "saved": saved, "time": entry["time"], "thumb": _jpeg_data_url(thumb)}

    def add(self, frame, label: str, split: str) -> dict:
        now = int(time.time() * 1000)
        if self._pending:
            now = max(now, self._pending[-1]["time"] + 1)
        entry = {"id": f"pending:{now}", "label": label, "split": split, "time": now, "frame": frame,
                 "thumb": _thumbnail_jpeg(frame, self.THUMB_SIZE, self.THUMB_QUALITY)}
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
                save_dir = os.path.join(self._datasets_path, entry["label"], entry["split"])
                os.makedirs(save_dir, exist_ok=True)
                name = f"{entry['time']}.jpg"
                path = os.path.join(save_dir, name)
                entry["frame"].save(path, "JPEG", quality=95)
                self._pending.remove(entry)
                saved.append({"id": item_id, "path": path,
                              "new_id": f"{entry['label']}/{entry['split']}/{name}"})
            except Exception as exc:
                errors.append({"id": item_id, "error": str(exc)})
        return saved, errors

    def discard_pending(self):
        self._pending = []


# ── Node ─────────────────────────────────────────────────────────────────────

class LabelerNode(Node):
    def __init__(self):
        super().__init__("labeler_node")

        # Parâmetros
        self.declare_parameter("classes", ["copo", "garrafa", "tigela", "caixa", "prato"])
        self.declare_parameter("datasets_path", os.path.expanduser("~/datasets"))
        self.declare_parameter("clip_model", "openai/clip-vit-base-patch32")
        self.declare_parameter("camera_topic", "/camera/color/image_raw")

        classes       = self.get_parameter("classes").value
        datasets_path = self.get_parameter("datasets_path").value
        clip_model    = self.get_parameter("clip_model").value
        camera_topic  = self.get_parameter("camera_topic").value

        self._datasets_path  = os.path.expanduser(datasets_path)
        self._lock           = threading.Lock()
        self._latest_frame   = None   # PIL Image — atualizado a cada frame
        self._captured_frame = None   # PIL Image — travado no classify, liberado no stage/discard
        self._gallery        = Gallery(self._datasets_path)

        # cv_bridge
        if _HAS_CV_BRIDGE:
            self._bridge = CvBridge()
        else:
            self._bridge = None
            self.get_logger().warn("cv_bridge não encontrado — usando conversão manual.")

        # Classificador
        self.get_logger().info(f"Carregando CLIP '{clip_model}'...")
        try:
            self._classifier = self._build_classifier(classes, clip_model)
            self.get_logger().info(f"Classificador pronto. Classes: {list(self._classifier.class_names)}")
        except Exception as exc:
            self.get_logger().error(f"Falha ao carregar classificador: {exc}")
            self._classifier = None

        # Interfaces ROS
        self.create_subscription(Image,  camera_topic,                       self._on_image,   10)
        self.create_subscription(String, "/fbot_webclient/labeler/request",  self._on_request, 10)
        self._pub = self.create_publisher(String, "/fbot_webclient/labeler/response", 10)

        self.get_logger().info(f"Labeler node pronto. Ouvindo câmera em '{camera_topic}'.")

    def _build_classifier(self, classes: list[str], clip_model: str) -> Classifier:
        """Treina com o dataset salvo quando ele existe; senão cai no zero-shot."""
        labels = {label for _, label in FewShotCLIPClassifier.list_samples(self._datasets_path)}
        if len(labels) < 2:
            self.get_logger().info(
                f"Sem dataset rotulado em '{self._datasets_path}' — usando CLIP zero-shot."
            )
            return ZeroShotCLIPClassifier(classes, clip_model)

        self.get_logger().info(f"Treinando classificador com o dataset em '{self._datasets_path}'...")
        classifier = FewShotCLIPClassifier(self._datasets_path, clip_model)
        self.get_logger().info(
            f"Treinado com {classifier.num_samples} imagens de {len(classifier.class_names)} classes."
        )
        return classifier

    # ── Callbacks ────────────────────────────────────────────────────────────

    def _on_image(self, msg: Image):
        try:
            if self._bridge:
                cv_img  = self._bridge.imgmsg_to_cv2(msg, desired_encoding="rgb8")
                pil_img = PILImage.fromarray(cv_img)
            else:
                channels = len(msg.data) // (msg.height * msg.width)
                arr = np.frombuffer(msg.data, dtype=np.uint8).reshape(msg.height, msg.width, channels)
                if "bgr" in msg.encoding.lower():
                    arr = arr[:, :, ::-1].copy()
                pil_img = PILImage.fromarray(arr.astype(np.uint8))

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
        if   action == "classify":        self._handle_classify(req)
        elif action == "stage":           self._handle_stage(req)
        elif action == "save":            self._handle_save(req)
        elif action == "gallery_list":    self._handle_gallery_list(req)
        elif action == "discard_unsaved": self._handle_discard_unsaved(req)
        elif action == "discard":
            with self._lock:
                self._captured_frame = None
        else:
            self.get_logger().warn(f"Ação desconhecida: '{action}'")

    # ── Handlers ─────────────────────────────────────────────────────────────

    def _handle_classify(self, req: dict):
        rid = req.get("request_id", "")

        with self._lock:
            if self._latest_frame is None:
                self._respond({"action": "classify", "success": False,
                               "error": "Nenhum frame disponível", "request_id": rid})
                return
            self._captured_frame = self._latest_frame.copy()
            frame = self._captured_frame

        if self._classifier is None:
            self._respond({"action": "classify", "success": False,
                           "error": "Classificador não carregado", "request_id": rid})
            return

        try:
            label, confidence = self._classifier.classify(frame)
            self.get_logger().info(f"Classificado: '{label}' ({confidence:.1%})")
            self._respond({"action": "classify", "success": True,
                           "label": label, "confidence": confidence,
                           "frame": _frame_to_data_url(frame), "request_id": rid})
        except Exception as exc:
            self.get_logger().error(f"Classificação falhou: {exc}")
            self._respond({"action": "classify", "success": False,
                           "error": str(exc), "request_id": rid})

    def _handle_stage(self, req: dict):
        rid   = req.get("request_id", "")
        label = str(req.get("label", "")).strip()
        split = req.get("split", "train")

        if not label or label.startswith(".") or "/" in label or "\\" in label:
            self._respond({"action": "stage", "success": False,
                           "error": "Label inválido", "request_id": rid})
            return
        if split not in SPLITS:
            self._respond({"action": "stage", "success": False,
                           "error": "Split inválido", "request_id": rid})
            return

        with self._lock:
            frame = self._captured_frame
            self._captured_frame = None

        if frame is None:
            self._respond({"action": "stage", "success": False,
                           "error": "Nenhum frame capturado", "request_id": rid})
            return

        try:
            item = self._gallery.add(frame, label, split)
            self.get_logger().info(f"Captura pendente: '{label}' ({split})")
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
            saved, errors = self._gallery.save(ids)
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
            items, total = self._gallery.page(offset)
            self._respond({"action": "gallery_list", "success": True,
                           "items": items, "offset": offset, "total": total})
        except Exception as exc:
            self.get_logger().error(f"Listagem da galeria falhou: {exc}")
            self._respond({"action": "gallery_list", "success": False, "error": str(exc)})

    def _handle_discard_unsaved(self, req: dict):
        self._gallery.discard_pending()
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
