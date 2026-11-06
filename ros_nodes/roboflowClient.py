"""The few Roboflow REST calls the Labeler uses (the same ones the roboflow Python SDK makes).

Config, read on every use so it can be created without restarting the node, from the
environment or ~/.config/fbot_webclient/roboflow.env (KEY=value lines). Kept out of the
web client's folder: scripts/serve.py serves that whole folder to the network.
  ROBOFLOW_API_KEY    the workspace's private API key
  ROBOFLOW_PROJECT    the project's id in its URL (app.roboflow.com/<workspace>/<project>)
  ROBOFLOW_WORKSPACE  optional; the key's own workspace by default
"""

import os
from pathlib import Path

import requests

API = "https://api.roboflow.com"
CONFIG_FILE = Path.home() / ".config" / "fbot_webclient" / "roboflow.env"
TIMEOUT_S = (10, 120)  # connect, read
EXPORT_FORMAT = "yolov8"  # YOLOv8 PyTorch TXT: polygons for a segmentation project


def load_config() -> dict:
    values = {}
    if CONFIG_FILE.is_file():
        for line in CONFIG_FILE.read_text().splitlines():
            name, sep, value = line.partition("=")
            if sep and not name.strip().startswith("#"):
                values[name.strip()] = value.strip().strip("'\"")
    for name in ("ROBOFLOW_API_KEY", "ROBOFLOW_PROJECT", "ROBOFLOW_WORKSPACE"):
        if os.environ.get(name):
            values[name] = os.environ[name]
    return values


class RoboflowError(Exception):
    pass


class Roboflow:
    def __init__(self, config: dict):
        self.key = config.get("ROBOFLOW_API_KEY", "")
        self.project = config.get("ROBOFLOW_PROJECT", "")
        if not self.key or not self.project:
            raise RoboflowError(f"Roboflow not configured: set ROBOFLOW_API_KEY and ROBOFLOW_PROJECT in {CONFIG_FILE}")
        self._workspace = config.get("ROBOFLOW_WORKSPACE") or None

    def redact(self, text) -> str:
        """Errors from requests carry the URL, and the URL carries the key."""
        return str(text).replace(self.key, "***")

    def _call(self, method, path, ok=(200,), **kwargs):
        try:
            response = requests.request(method, API + path, params={"api_key": self.key, **kwargs.pop("params", {})},
                                        timeout=TIMEOUT_S, **kwargs)
        except requests.RequestException as e:
            raise RoboflowError(self.redact(e)) from None
        try:
            body = response.json()
        except ValueError:
            body = {}
        if response.status_code not in ok:
            detail = body.get("error") or body.get("message") or response.text[:300]
            raise RoboflowError(self.redact(f"Roboflow {response.status_code}: {detail}"))
        return response.status_code, body

    def workspace(self) -> str:
        if self._workspace is None:
            self._workspace = self._call("GET", "/")[1]["workspace"]
        return self._workspace

    def upload(self, path: Path, split: str, batch: str) -> str:
        """Uploads one image; returns its id (also for one Roboflow already had)."""
        with open(path, "rb") as f:
            _, body = self._call("POST", f"/dataset/{self.project}/upload", params={"batch": batch},
                                 data={"name": path.name, "split": split},
                                 files={"file": (path.name, f, "image/jpeg")})
        if not (body.get("success") or body.get("duplicate")) or "id" not in body:
            raise RoboflowError(self.redact(f"Upload of {path.name} refused: {body}"))
        return body["id"]

    def annotate(self, image_id: str, name: str, annotation: str) -> bool:
        """Saves an annotation file (here a COCO JSON naming the image) on an uploaded image. Never over
        one already there (a person may have fixed it in Roboflow): returns False then, as the SDK does
        with its 409 "already annotated"."""
        status, _ = self._call("POST", f"/dataset/{self.project}/annotate/{image_id}", ok=(200, 409),
                               params={"name": name}, json={"annotationFile": annotation, "labelmap": None})
        return status == 200

    def versions(self) -> list[int]:
        _, body = self._call("GET", f"/{self.workspace()}/{self.project}")
        # The list is at the top; project.versions is only their count.
        return sorted(int(v["id"].rsplit("/", 1)[-1]) for v in body.get("versions", []))

    def generate_version(self) -> int:
        """A new dataset version from the current annotations, as is (no resize, no augmentation)."""
        _, body = self._call("POST", f"/{self.workspace()}/{self.project}/generate",
                             json={"preprocessing": {"auto-orient": True}, "augmentation": {}})
        return int(body["version"])

    def export_link(self, version: int) -> str | None:
        """The download link of a version's export, or None while Roboflow is still preparing it."""
        status, body = self._call("GET", f"/{self.workspace()}/{self.project}/{version}/{EXPORT_FORMAT}",
                                  ok=(200, 202), params={"nocache": "true"})
        return body.get("export", {}).get("link") if status == 200 else None
