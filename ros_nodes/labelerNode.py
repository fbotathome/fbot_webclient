#!/usr/bin/env python3
"""
Labeler node — classifica objetos via CLIP zero-shot e salva frames rotulados.

Tópicos:
  SUB  /camera/color/image_raw          sensor_msgs/Image
  SUB  /fbot_webclient/labeler/request  std_msgs/String  (JSON)
  PUB  /fbot_webclient/labeler/response std_msgs/String  (JSON)

Protocolo JSON (request):
  { "action": "classify", "request_id": "<str>" }
  { "action": "save",     "label": "<str>", "split": "train"|"valid", "request_id": "<str>" }
  { "action": "discard",  "request_id": "<str>" }

Protocolo JSON (response):
  { "action": "classify", "success": true,  "label": "<str>", "confidence": 0.87, "request_id": "<str>" }
  { "action": "classify", "success": false, "error": "<str>", "request_id": "<str>" }
  { "action": "save",     "success": true,  "path": "<str>",  "request_id": "<str>" }
  { "action": "save",     "success": false, "error": "<str>", "request_id": "<str>" }
"""

import json
import os
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
            text=self.class_names,
            images=pil_image,
            return_tensors="pt",
            padding=True,
        ).to(self.device)

        with torch.no_grad():
            outputs = self.model(**inputs)

        probs = outputs.logits_per_image.softmax(dim=-1)[0]
        best_idx = int(probs.argmax())
        return self.class_names[best_idx], float(probs[best_idx])


# ── Node ─────────────────────────────────────────────────────────────────────

class LabelerNode(Node):
    def __init__(self):
        super().__init__("labeler_node")

        # Parâmetros
        self.declare_parameter("classes", ["copo", "garrafa", "tigela", "caixa", "prato"])
        self.declare_parameter("datasets_path", os.path.expanduser("~/datasets"))
        self.declare_parameter("clip_model", "openai/clip-vit-base-patch32")

        classes       = self.get_parameter("classes").value
        datasets_path = self.get_parameter("datasets_path").value
        clip_model    = self.get_parameter("clip_model").value

        self._datasets_path  = os.path.expanduser(datasets_path)
        self._lock           = threading.Lock()
        self._latest_frame   = None   # PIL Image — atualizado a cada frame
        self._captured_frame = None   # PIL Image — travado no classify, liberado no save/discard

        # cv_bridge
        if _HAS_CV_BRIDGE:
            self._bridge = CvBridge()
        else:
            self._bridge = None
            self.get_logger().warn("cv_bridge não encontrado — usando conversão manual.")

        # Classificador
        self.get_logger().info(f"Carregando CLIP '{clip_model}'...")
        try:
            self._classifier = ZeroShotCLIPClassifier(classes, clip_model)
            self.get_logger().info(f"Classificador pronto. Classes: {list(classes)}")
        except Exception as exc:
            self.get_logger().error(f"Falha ao carregar classificador: {exc}")
            self._classifier = None

        # Interfaces ROS
        self.create_subscription(Image,  "/camera/color/image_raw",         self._on_image,   10)
        self.create_subscription(String, "/fbot_webclient/labeler/request",  self._on_request, 10)
        self._pub = self.create_publisher(String, "/fbot_webclient/labeler/response", 10)

        self.get_logger().info("Labeler node pronto.")

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
        if   action == "classify": self._handle_classify(req)
        elif action == "save":     self._handle_save(req)
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
                           "label": label, "confidence": confidence, "request_id": rid})
        except Exception as exc:
            self.get_logger().error(f"Classificação falhou: {exc}")
            self._respond({"action": "classify", "success": False,
                           "error": str(exc), "request_id": rid})

    def _handle_save(self, req: dict):
        rid   = req.get("request_id", "")
        label = req.get("label", "").strip()
        split = req.get("split", "train")

        if not label:
            self._respond({"action": "save", "success": False,
                           "error": "Label vazio", "request_id": rid})
            return

        with self._lock:
            frame = self._captured_frame
            self._captured_frame = None

        if frame is None:
            self._respond({"action": "save", "success": False,
                           "error": "Nenhum frame capturado", "request_id": rid})
            return

        try:
            save_dir = os.path.join(self._datasets_path, label, split)
            os.makedirs(save_dir, exist_ok=True)
            filepath = os.path.join(save_dir, f"{int(time.time() * 1000)}.jpg")
            frame.save(filepath, "JPEG", quality=95)
            self.get_logger().info(f"Salvo: {filepath}")
            self._respond({"action": "save", "success": True,
                           "path": filepath, "request_id": rid})
        except Exception as exc:
            self.get_logger().error(f"Salvamento falhou: {exc}")
            self._respond({"action": "save", "success": False,
                           "error": str(exc), "request_id": rid})

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
