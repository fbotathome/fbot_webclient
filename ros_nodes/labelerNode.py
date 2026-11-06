#!/usr/bin/env python3
"""
Labeler node — o fluxo de dataset da competição pela página:
  1. guarda as fotos que a página tira (a câmera do navegador, ou o tópico da câmera do robô
     quando o navegador não tem câmera) numa rodada, uma pasta de imagens por split;
  2. sobe a rodada no Roboflow, onde as fotos de demonstração são anotadas com polígonos;
  3. baixa o dataset (export yolov8 de uma versão) e treina um YOLO de segmentação;
  4. rotula outra rodada com o modelo e sobe as fotos já anotadas para revisar no Roboflow.
Os passos 2 a 4 são jobs, um por vez, numa thread; treino e rotulagem rodam o
labelerTrain.py como subprocesso (o node não importa o torch).

Tópicos:
  SUB  <camera_topic>                   sensor_msgs/Image (só quando a foto vem sem "image")
  SUB  /fbot_webclient/labeler/request  std_msgs/String  (JSON)
  PUB  /fbot_webclient/labeler/response std_msgs/String  (JSON)

Protocolo JSON (request):
  { "action": "capture",         "round": "<str>", "split": "train"|"valid", "image"?: "data:image/jpeg;base64,..." }
  { "action": "save",            "ids": ["<str>", ...] }
  { "action": "gallery_list",    "round": "<str>", "offset": <int> }
  { "action": "discard_unsaved", "round": "<str>" }
  { "action": "rounds" }
  { "action": "status" }                                  Roboflow configurado, datasets, modelos, job
  { "action": "upload",          "round": "<str>", "labels": <bool> }   fotos (e anotações do modelo) → Roboflow
  { "action": "dataset",         "new_version": <bool> }  gera (ou pega a última) versão e baixa o export
  { "action": "train",           "version": "v<N>", "epochs": <int> }
  { "action": "label",           "round": "<str>", "model": "v<N>" }
  { "action": "cancel_job" }

Protocolo JSON (response):
  { "action": "capture",  "success": true,  "item": <item> }
  { "action": "capture",  "success": false, "error": "<str>" }
  { "action": "save",     "success": <bool>,
    "saved":  [{"id": "<str>", "new_id": "<str>", "path": "<str>"}],
    "errors": [{"id": "<str>", "error": "<str>"}] }
  { "action": "gallery_list",    "success": true, "round": "<str>", "items": [<item>, ...], "offset": <int>, "total": <int> }
  { "action": "discard_unsaved", "success": true, "round": "<str>" }
  { "action": "rounds",          "success": true,
    "rounds": [{"name": "<str>", "train": <int>, "valid": <int>, "labeled": <int>}] }
  { "action": "status",          "success": true, "roboflow": {"configured": <bool>, "project": "<str>"|null,
    "config_file": "<str>"}, "versions": ["v<N>", ...], "models": ["v<N>", ...], "job": <job>|null }
  { "action": "job",             "success": true, "job": <job> }   no início, a cada segundo com novidade, no fim
  (um pedido inválido volta com "success": false e "error")

  <job>  = { "kind": "upload"|"dataset"|"train"|"label", "label": "<str>",
             "state": "running"|"done"|"failed"|"canceled", "message": "<str>", "lines": ["<str>", ...] }

  <item> = { "id": "<str>", "round": "<str>", "split": "<str>", "saved": <bool>, "time": <ms>,
             "thumb": "data:image/jpeg;base64,..." }

Fluxo: "capture" guarda a foto como captura pendente, só em memória; "save" grava as
pendentes escolhidas. O que não foi salvo some quando o node reinicia.

Pastas em {root}:
  {rodada}/{train|valid}/{timestamp}.jpg   só imagens
  _versions/v<N>/                          export yolov8 da versão N do Roboflow
  _models/v<N>/weights/best.pt             modelo treinado no dataset v<N> (e os pesos base, baixados aqui)
  _labels/{rodada}/{split}/{foto}.json     anotação COCO do modelo para cada foto
  _roboflow/{rodada}.json                  o que já subiu: {"train/<foto>": {"id", "labeled"}}
"""

import base64
import io
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
import zipfile
from collections import deque
from pathlib import Path

import numpy as np
import rclpy
import requests
from PIL import Image as PILImage
from rclpy.executors import ExternalShutdownException
from rclpy.node import Node
from sensor_msgs.msg import Image
from std_msgs.msg import String

from roboflowClient import CONFIG_FILE, Roboflow, RoboflowError, load_config

SPLITS = ("train", "valid")
GALLERY_PAGE_SIZE = 24
# Nome das fotos gravadas pelo labeler ({timestamp em ms}.jpg) — a galeria só lista essas.
CAPTURE_NAME = re.compile(r"\d+\.jpg")
# Vem da rede: vira nome de pasta. Sem "_" no começo, que é das pastas que não são rodada.
ROUND_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,39}")
JPEG_DATA_URL = "data:image/jpeg;base64,"
MAX_IMAGE_CHARS = 16_000_000  # base64 de um JPEG de ~12 MB; uma foto 1920 px fica bem abaixo
# Um frame mais velho que isso é de uma câmera que parou: salvá-lo repetiria a mesma foto.
MAX_FRAME_AGE_S = 2.0
# Vem da rede: vira nome de pasta (versão do dataset = nome do modelo treinado nela).
VERSION_NAME = re.compile(r"v\d{1,5}")
MAX_EPOCHS = 1000
TRAIN_SCRIPT = Path(__file__).resolve().with_name("labelerTrain.py")
SUBPROCESS_ENV = {"PYTHONUNBUFFERED": "1", "YOLO_AUTOINSTALL": "false"}  # never pip install mid-competition
ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")  # ultralytics' progress bars clear the line with these
JOB_LINES_KEPT = 200
JOB_LINES_SENT = 40
JOB_STOP_TIMEOUT_S = 10  # SIGINT, then SIGKILL
EXPORT_POLL_S = 3
EXPORT_TIMEOUT_S = 600   # Roboflow prepares a new version's export


def _version_name(name) -> str:
    if not isinstance(name, str) or not VERSION_NAME.fullmatch(name):
        raise ValueError("Versão inválida (ex.: v3)")
    return name


def _killpg(pid, sig):
    try:
        os.killpg(pid, sig)
    except ProcessLookupError:
        pass  # already gone


def _write_json(path: Path, data):
    # Temporário e troca: um crash no meio não perde o que já foi enviado.
    path.parent.mkdir(parents=True, exist_ok=True)
    path.with_suffix(".tmp").write_text(json.dumps(data))
    os.replace(path.with_suffix(".tmp"), path)


class Job:
    """One long piece of work (a Roboflow transfer, a training, a labeling), run in a thread."""

    def __init__(self, kind: str, label: str):
        self.kind, self.label = kind, label
        self.state, self.message = "running", ""
        self.lines = deque(maxlen=JOB_LINES_KEPT)
        self._lines_lock = threading.Lock()  # the job's thread appends while the node's timer copies
        self.cancel = threading.Event()
        self.process = None
        # Whatever a job prints passes through here: a Roboflow error can carry the API key.
        self.secret = load_config().get("ROBOFLOW_API_KEY")
        self.changed = True

    def redact(self, text) -> str:
        text = str(text)
        return text.replace(self.secret, "***") if self.secret else text

    def line(self, text):
        with self._lines_lock:
            self.lines.append(ANSI.sub("", self.redact(text)))
        self.changed = True

    def public(self) -> dict:
        with self._lines_lock:
            lines = list(self.lines)[-JOB_LINES_SENT:]
        return {"kind": self.kind, "label": self.label, "state": self.state, "message": self.message, "lines": lines}


def _round_name(name) -> str:
    if not isinstance(name, str) or not ROUND_NAME.fullmatch(name):
        raise ValueError("Nome de rodada inválido (letras, números, _ e -, até 40)")
    return name


def _decode_jpeg(data_url) -> bytes:
    """Os bytes do JPEG vindo da página, conferidos: tamanho, base64 e que o PIL abre como JPEG."""
    if not isinstance(data_url, str) or not data_url.startswith(JPEG_DATA_URL) or len(data_url) > MAX_IMAGE_CHARS:
        raise ValueError("Imagem inválida (esperado um JPEG em data URL)")
    try:
        jpeg = base64.b64decode(data_url[len(JPEG_DATA_URL):], validate=True)
        with PILImage.open(io.BytesIO(jpeg)) as img:
            if img.format != "JPEG":
                raise ValueError
            img.verify()
    except Exception:
        raise ValueError("Imagem inválida (JPEG corrompido)") from None
    return jpeg


def _thumbnail_jpeg(jpeg: bytes, max_size: int, quality: int) -> bytes:
    with PILImage.open(io.BytesIO(jpeg)) as img:
        thumb = img.convert("RGB")
    thumb.thumbnail((max_size, max_size))
    buf = io.BytesIO()
    thumb.save(buf, "JPEG", quality=quality)
    return buf.getvalue()


def _jpeg_data_url(jpeg: bytes) -> str:
    return JPEG_DATA_URL + base64.b64encode(jpeg).decode("ascii")


# ── Dataset ──────────────────────────────────────────────────────────────────

class Dataset:
    """
    As fotos em disco, por rodada, mais as capturas que ainda não foram salvas (só em
    memória). A galeria do webclient lista as fotos do labeler já salvas
    ({timestamp}.jpg) e as pendentes de uma rodada; salvar grava a foto no split.
    """

    THUMB_SIZE = 240
    THUMB_QUALITY = 75

    def __init__(self, root: str):
        self._root = root
        self._pending = []   # [{id, round, split, time, jpeg, thumb}], oldest first
        self._thumbs = {}    # (path, mtime) → JPEG bytes

    def rounds(self) -> list[dict]:
        names = sorted(n for n in os.listdir(self._root) if ROUND_NAME.fullmatch(n)) if os.path.isdir(self._root) else []
        counts = []
        for name in names:
            entries = self._saved_entries(name)
            labels = os.path.join(self._root, "_labels", name)
            labeled = sum(len(files) for _, _, files in os.walk(labels))
            counts.append({"name": name, **{s: sum(e["split"] == s for e in entries) for s in SPLITS},
                           "labeled": labeled})
        return counts

    def saved_photos(self, round_name: str) -> list[tuple[str, Path]]:
        """(split, path) of the round's saved photos, oldest first."""
        return [(e["split"], Path(e["path"])) for e in self._saved_entries(round_name)]

    def _saved_entries(self, round_name: str) -> list[dict]:
        entries = []
        for split in SPLITS:
            split_dir = os.path.join(self._root, round_name, split)
            if not os.path.isdir(split_dir):
                continue
            for name in os.listdir(split_dir):
                path = os.path.join(split_dir, name)
                if CAPTURE_NAME.fullmatch(name) and os.path.isfile(path):
                    entries.append({"id": f"{round_name}/{split}/{name}", "round": round_name, "split": split,
                                    "path": path, "time": int(name[:-4])})
        entries.sort(key=lambda e: (e["time"], e["id"]))
        return entries

    def _saved_thumb(self, entry: dict) -> bytes:
        key = (entry["path"], os.path.getmtime(entry["path"]))
        if key not in self._thumbs:
            with open(entry["path"], "rb") as f:
                self._thumbs[key] = _thumbnail_jpeg(f.read(), self.THUMB_SIZE, self.THUMB_QUALITY)
        return self._thumbs[key]

    def _public(self, entry: dict) -> dict:
        saved = "jpeg" not in entry
        thumb = self._saved_thumb(entry) if saved else entry["thumb"]
        return {"id": entry["id"], "round": entry["round"], "split": entry["split"], "saved": saved,
                "time": entry["time"], "thumb": _jpeg_data_url(thumb)}

    def add(self, round_name: str, jpeg: bytes, split: str) -> dict:
        now = int(time.time() * 1000)
        if self._pending:
            now = max(now, self._pending[-1]["time"] + 1)
        entry = {"id": f"pending:{now}", "round": round_name, "split": split, "time": now, "jpeg": jpeg,
                 "thumb": _thumbnail_jpeg(jpeg, self.THUMB_SIZE, self.THUMB_QUALITY)}
        self._pending.append(entry)
        return self._public(entry)

    def page(self, round_name: str, offset: int, limit: int = GALLERY_PAGE_SIZE) -> tuple[list[dict], int]:
        """Returns (items, total): saved images oldest first, then the pending ones."""
        entries = self._saved_entries(round_name) + [e for e in self._pending if e["round"] == round_name]
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
                # Os dois splits: quem lê a rodada pode esperar os dois.
                for split in SPLITS:
                    os.makedirs(os.path.join(self._root, entry["round"], split), exist_ok=True)
                name = f"{entry['time']}.jpg"
                path = os.path.join(self._root, entry["round"], entry["split"], name)
                with open(path, "wb") as f:
                    f.write(entry["jpeg"])

                self._pending.remove(entry)
                saved.append({"id": item_id, "path": path, "new_id": f"{entry['round']}/{entry['split']}/{name}"})
            except Exception as exc:
                errors.append({"id": item_id, "error": str(exc)})
        return saved, errors

    def discard_pending(self, round_name: str):
        self._pending = [e for e in self._pending if e["round"] != round_name]


# ── Node ─────────────────────────────────────────────────────────────────────

class LabelerNode(Node):
    def __init__(self):
        super().__init__("labeler_node")

        # Parâmetros (ros_nodes/labeler_params.yaml, passado pelo start.sh)
        self.declare_parameter("root", os.path.expanduser("~/labeler_fotos"))
        self.declare_parameter("camera_topic", "/camera/color/image_raw")
        self.declare_parameter("base_model", "yolo11n-seg.pt")

        root         = os.path.expanduser(self.get_parameter("root").value)
        camera_topic = self.get_parameter("camera_topic").value
        self._base_model = self.get_parameter("base_model").value

        self._root         = Path(root)
        self._lock         = threading.Lock()
        self._latest_frame = None   # (time.monotonic() da chegada, PIL Image) — atualizado a cada frame
        self._dataset      = Dataset(root)
        self._job          = None   # o último Job (rodando ou terminado)

        # Interfaces ROS
        self.create_subscription(Image,  camera_topic,                       self._on_image,   10)
        self.create_subscription(String, "/fbot_webclient/labeler/request",  self._on_request, 10)
        self._pub = self.create_publisher(String, "/fbot_webclient/labeler/response", 10)
        self.create_timer(1.0, self._publish_job)

        self.get_logger().info(f"Labeler node pronto. Rodadas em '{root}'; sem câmera no navegador, "
                               f"usa '{camera_topic}'.")

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
                self._latest_frame = (time.monotonic(), pil_img)

        except Exception as exc:
            self.get_logger().error(f"Conversão de imagem falhou: {exc}")

    def _on_request(self, msg: String):
        try:
            req = json.loads(msg.data)
        except json.JSONDecodeError:
            self.get_logger().error("JSON inválido no request.")
            return

        action = req.get("action")
        handler = {
            "capture":         self._handle_capture,
            "save":            self._handle_save,
            "gallery_list":    self._handle_gallery_list,
            "discard_unsaved": self._handle_discard_unsaved,
            "rounds":          self._handle_rounds,
            "status":          self._handle_status,
            "upload":          self._handle_upload,
            "dataset":         self._handle_dataset,
            "train":           self._handle_train,
            "label":           self._handle_label,
            "cancel_job":      self._handle_cancel_job,
        }.get(action)
        if handler is None:
            self.get_logger().warn(f"Ação desconhecida: '{action}'")
            return
        try:
            handler(req)
        except ValueError as exc:   # pedido inválido: nome de rodada, split, imagem
            self._respond({"action": action, "success": False, "error": str(exc)})

    # ── Handlers ─────────────────────────────────────────────────────────────

    def _camera_jpeg(self) -> bytes:
        """O último frame do tópico da câmera, em JPEG, se for recente."""
        with self._lock:
            latest = self._latest_frame
        if latest is None:
            raise ValueError("Nenhum frame disponível")
        received_at, frame = latest
        if time.monotonic() - received_at > MAX_FRAME_AGE_S:
            raise ValueError(f"Câmera parada: nenhum frame nos últimos {MAX_FRAME_AGE_S:g} s")
        buf = io.BytesIO()
        frame.save(buf, "JPEG", quality=95)
        return buf.getvalue()

    def _handle_capture(self, req: dict):
        round_name = _round_name(req.get("round"))
        split = req.get("split", "train")
        if split not in SPLITS:
            raise ValueError("Split inválido")
        jpeg = _decode_jpeg(req["image"]) if "image" in req else self._camera_jpeg()

        item = self._dataset.add(round_name, jpeg, split)
        self.get_logger().info(f"Captura pendente ({round_name}/{split})")
        self._respond({"action": "capture", "success": True, "item": item})

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
        round_name = _round_name(req.get("round"))
        try:
            offset = max(int(req.get("offset", 0)), 0)
            items, total = self._dataset.page(round_name, offset)
            self._respond({"action": "gallery_list", "success": True, "round": round_name,
                           "items": items, "offset": offset, "total": total})
        except Exception as exc:
            self.get_logger().error(f"Listagem da galeria falhou: {exc}")
            self._respond({"action": "gallery_list", "success": False, "error": str(exc)})

    def _handle_discard_unsaved(self, req: dict):
        round_name = _round_name(req.get("round"))
        self._dataset.discard_pending(round_name)
        self._respond({"action": "discard_unsaved", "success": True, "round": round_name})

    def _handle_rounds(self, req: dict):
        self._respond({"action": "rounds", "success": True, "rounds": self._dataset.rounds()})

    # ── Pipeline (Roboflow, treino, rotulagem) ──────────────────────────────

    def _done_versions(self, folder: str, marker: str) -> list[str]:
        base = self._root / folder
        names = [p.name for p in base.iterdir() if VERSION_NAME.fullmatch(p.name) and (p / marker).is_file()] \
            if base.is_dir() else []
        return sorted(names, key=lambda n: int(n[1:]))

    def _handle_status(self, req: dict):
        config = load_config()
        self._respond({
            "action": "status", "success": True,
            "roboflow": {"configured": bool(config.get("ROBOFLOW_API_KEY") and config.get("ROBOFLOW_PROJECT")),
                         "project": config.get("ROBOFLOW_PROJECT"), "config_file": str(CONFIG_FILE)},
            "versions": self._done_versions("_versions", "data.yaml"),
            "models": self._done_versions("_models", "weights/best.pt"),
            "job": self._job.public() if self._job else None,
        })

    def _start_job(self, kind: str, label: str, work):
        """Runs work(job) in a thread; its return value is the job's final message."""
        with self._lock:
            if self._job and self._job.state == "running":
                raise ValueError(f"{self._job.label}: still running")
            job = self._job = Job(kind, label)
        self.get_logger().info(f"Job: {label}")

        def run():
            try:
                job.message = job.redact(work(job) or "Done")
                job.state = "canceled" if job.cancel.is_set() else "done"
            except Exception as exc:  # the page shows why; the node carries on
                job.state = "canceled" if job.cancel.is_set() else "failed"
                job.message = job.redact(exc)
            job.changed = True
            self.get_logger().info(f"Job {label}: {job.state} — {job.message}")

        threading.Thread(target=run, daemon=True).start()
        self._publish_job()

    def _publish_job(self):
        job = self._job
        if job and job.changed:
            job.changed = False
            self._respond({"action": "job", "success": True, "job": job.public()})

    def _run_process(self, job: Job, argv: list, cwd: Path):
        """A subprocess in its own process group, its output going to the job's lines."""
        job.line("$ " + " ".join(str(a) for a in argv))
        cwd.mkdir(parents=True, exist_ok=True)
        process = subprocess.Popen(
            [str(a) for a in argv], cwd=cwd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT, text=True, errors="replace", start_new_session=True,
            env={**os.environ, **SUBPROCESS_ENV},
            # Started with & from start.sh, this node may have SIGINT ignored; SIGINT is how the job stops.
            preexec_fn=lambda: signal.signal(signal.SIGINT, signal.SIG_DFL),
        )
        job.process = process
        try:
            for raw in process.stdout:   # progress bars end in \r: each update is a line
                if raw.strip():
                    job.line(raw.rstrip())
        finally:
            code = process.wait()
            job.process = None
        if job.cancel.is_set():
            # Not the caller's success message ("Model v3 trained") for a training that was stopped.
            raise RuntimeError("Canceled")
        if code != 0:
            last = job.public()["lines"][-1:] or ["no output"]
            raise RuntimeError(f"{argv[2]} failed (exit {code}): {last[0]}")

    def _handle_cancel_job(self, req: dict):
        job = self._job
        if not job or job.state != "running":
            raise ValueError("No job is running")
        job.cancel.set()
        job.line("[cancel requested]")
        process = job.process
        if process:
            _killpg(process.pid, signal.SIGINT)
            threading.Timer(JOB_STOP_TIMEOUT_S,
                            lambda: process.poll() is None and _killpg(process.pid, signal.SIGKILL)).start()

    def stop_job(self):
        """Before exiting: a training in its own session would otherwise keep running, holding the GPU."""
        process = self._job and self._job.process
        if process and process.poll() is None:
            _killpg(process.pid, signal.SIGINT)
            try:
                process.wait(timeout=JOB_STOP_TIMEOUT_S)
            except subprocess.TimeoutExpired:
                _killpg(process.pid, signal.SIGKILL)

    def _handle_upload(self, req: dict):
        round_name = _round_name(req.get("round"))
        with_labels = bool(req.get("labels"))
        photos = self._dataset.saved_photos(round_name)
        if not photos:
            raise ValueError(f"{round_name} has no saved photos")
        labels_dir = self._root / "_labels" / round_name
        if with_labels and not labels_dir.is_dir():
            raise ValueError(f"Label {round_name} with a model first")
        state_path = self._root / "_roboflow" / f"{round_name}.json"

        def work(job):
            roboflow = Roboflow(load_config())
            state = json.loads(state_path.read_text()) if state_path.is_file() else {}
            sent = annotated = 0
            for split, path in photos:
                if job.cancel.is_set():
                    break
                key = f"{split}/{path.name}"
                entry = state.setdefault(key, {})
                if "id" not in entry:
                    entry["id"] = roboflow.upload(path, split, batch=round_name)
                    sent += 1
                    _write_json(state_path, state)
                label_file = labels_dir / split / f"{path.name}.json"
                if with_labels and not entry.get("labeled") and label_file.is_file():
                    coco = label_file.read_text()
                    if json.loads(coco)["annotations"]:
                        if roboflow.annotate(entry["id"], f"{path.stem}.json", coco):
                            annotated += 1
                        else:
                            job.line(f"{key}: already annotated in Roboflow, kept")
                    entry["labeled"] = True
                    _write_json(state_path, state)
                job.line(f"{key}: ok")
            return (f"Sent {sent} new photos" + (f" and {annotated} annotations" if with_labels else "")
                    + f" to {roboflow.project}")

        self._start_job("upload", f"Send {round_name} to Roboflow", work)

    def _handle_dataset(self, req: dict):
        new_version = bool(req.get("new_version"))

        def work(job):
            roboflow = Roboflow(load_config())
            if new_version:
                version = roboflow.generate_version()
                job.line(f"Generated version {version}")
            else:
                versions = roboflow.versions()
                if not versions:
                    raise RuntimeError("The project has no version yet: use New version")
                version = versions[-1]
            deadline = time.monotonic() + EXPORT_TIMEOUT_S
            while True:
                try:
                    link = roboflow.export_link(version)
                except RoboflowError as exc:
                    if not new_version:
                        raise
                    link = None  # a version just generated may not be exportable yet
                    job.line(f"Not ready: {exc}")
                if link or job.cancel.is_set():
                    break
                if time.monotonic() > deadline:
                    raise RuntimeError(f"Roboflow took over {EXPORT_TIMEOUT_S // 60} min to export v{version}")
                job.line(f"Roboflow is preparing the export of v{version}…")
                time.sleep(EXPORT_POLL_S)
            if not link:
                return "Canceled"

            target = self._root / "_versions" / f"v{version}"
            partial = target.with_name(target.name + ".part")
            shutil.rmtree(partial, ignore_errors=True)
            partial.mkdir(parents=True)
            archive = partial / "export.zip"
            job.line(f"Downloading v{version}…")
            # The link carries a download token: it isn't logged.
            with requests.get(link, stream=True, timeout=(10, 120)) as response:
                response.raise_for_status()
                with open(archive, "wb") as f:
                    for chunk in response.iter_content(1 << 20):
                        f.write(chunk)
            with zipfile.ZipFile(archive) as z:
                z.extractall(partial)   # zipfile drops absolute paths and ".."
            archive.unlink()
            if not (partial / "data.yaml").is_file():
                raise RuntimeError("The export has no data.yaml: is it a segmentation project?")
            images = sum(1 for _ in partial.glob("*/images/*"))
            if images == 0:
                shutil.rmtree(partial, ignore_errors=True)
                # Uploaded and annotated images wait in Roboflow's Annotate queue until added to the dataset.
                raise RuntimeError(f"Version {version} has no images: in Roboflow, Annotate → add the annotated "
                                   "images to the dataset, then make a new version")
            shutil.rmtree(target, ignore_errors=True)
            partial.rename(target)
            return f"Dataset v{version} ready ({images} images)"

        self._start_job("dataset", "New version" if new_version else "Download latest version", work)

    def _handle_train(self, req: dict):
        version = _version_name(req.get("version"))
        try:
            epochs = int(req.get("epochs", 50))
        except (TypeError, ValueError):
            raise ValueError("Epochs must be a number") from None
        if not 1 <= epochs <= MAX_EPOCHS:
            raise ValueError(f"Epochs: 1 to {MAX_EPOCHS}")
        data = self._root / "_versions" / version / "data.yaml"
        if not data.is_file():
            raise ValueError(f"Dataset {version} isn't downloaded")
        models = self._root / "_models"

        def work(job):
            # Trains into v<N>.part: only a training that finishes replaces v<N>, so a canceled or failed
            # retrain keeps the last good model (ultralytics rewrites best.pt after every epoch).
            partial = models / f"{version}.part"
            shutil.rmtree(partial, ignore_errors=True)
            try:
                # cwd in _models: the base weights download there, not into the served web client.
                self._run_process(job, [sys.executable, TRAIN_SCRIPT, "train", "--data", data, "--model",
                                        self._base_model, "--project", models, "--name", partial.name,
                                        "--epochs", epochs], cwd=models)
            except Exception:
                shutil.rmtree(partial, ignore_errors=True)
                raise
            target = models / version
            shutil.rmtree(target, ignore_errors=True)
            partial.rename(target)
            return f"Model {version} trained"

        self._start_job("train", f"Train on {version}", work)

    def _handle_label(self, req: dict):
        round_name = _round_name(req.get("round"))
        model = _version_name(req.get("model"))
        weights = self._root / "_models" / model / "weights" / "best.pt"
        if not weights.is_file():
            raise ValueError(f"Model {model} isn't trained")
        if not self._dataset.saved_photos(round_name):
            raise ValueError(f"{round_name} has no saved photos")
        out = self._root / "_labels" / round_name
        state_path = self._root / "_roboflow" / f"{round_name}.json"

        def work(job):
            self._run_process(job, [sys.executable, TRAIN_SCRIPT, "label", "--model", weights,
                                    "--images", self._root / round_name, "--out", out], cwd=self._root / "_models")
            # New labels: offer them again; Roboflow keeps any image already annotated (see annotate).
            if state_path.is_file():
                state = json.loads(state_path.read_text())
                for entry in state.values():
                    entry.pop("labeled", None)
                _write_json(state_path, state)
            return f"{round_name} labeled with {model}"

        self._start_job("label", f"Label {round_name} with {model}", work)

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
    except (KeyboardInterrupt, ExternalShutdownException):  # Ctrl+C, or SIGTERM from start.sh
        pass
    finally:
        node.stop_job()
        node.destroy_node()
        rclpy.try_shutdown()


if __name__ == "__main__":
    main()
