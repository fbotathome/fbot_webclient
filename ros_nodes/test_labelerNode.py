"""Checks that the labeler saves only images, per round and split, lists them back, and
refuses round names and images from the page that could escape the folder or aren't JPEGs.
Run with the ROS environment sourced: python3 ros_nodes/test_labelerNode.py (or pytest)."""
import base64
import io
import os
import sys
import tempfile

from PIL import Image

sys.path.insert(0, os.path.dirname(__file__))
from labelerNode import JPEG_DATA_URL, Dataset, _decode_jpeg, _round_name, _version_name  # noqa: E402


def _jpeg(fmt="JPEG"):
    buf = io.BytesIO()
    Image.new("RGB", (200, 100), "red").save(buf, fmt)
    return buf.getvalue()


def _refuses(fn, value):
    try:
        fn(value)
    except ValueError:
        return True
    return False


def test_save_writes_images_and_lists_them():
    with tempfile.TemporaryDirectory() as root:
        dataset = Dataset(root)
        first = dataset.add("demo", _jpeg(), "train")
        second = dataset.add("demo", _jpeg(), "valid")
        other = dataset.add("lote", _jpeg(), "train")
        assert not first["saved"] and second["time"] > first["time"]

        saved, errors = dataset.save([first["id"], second["id"], "pending:0"])
        assert len(saved) == 2 and [e["id"] for e in errors] == ["pending:0"]
        assert saved[0]["new_id"].startswith("demo/train/") and open(saved[0]["path"], "rb").read() == _jpeg()
        # Only images, in both split folders.
        assert sorted(os.listdir(os.path.join(root, "demo"))) == ["train", "valid"]

        # A file the labeler did not write is left out of the gallery; each round lists its own.
        open(os.path.join(root, "demo", "train", "notes.txt"), "w").close()
        items, total = dataset.page("demo", 0)
        assert total == 2 and [i["split"] for i in items] == ["train", "valid"] and all(i["saved"] for i in items)
        assert [i["id"] for i in dataset.page("lote", 0)[0]] == [other["id"]]

        os.makedirs(os.path.join(root, "_models"))
        os.makedirs(os.path.join(root, "_labels", "demo", "train"))
        open(os.path.join(root, "_labels", "demo", "train", "1.jpg.json"), "w").close()
        assert dataset.rounds() == [{"name": "demo", "train": 1, "valid": 1, "labeled": 1}]
        dataset.discard_pending("lote")
        assert dataset.page("lote", 0)[1] == 0


def test_refuses_bad_input_from_the_page():
    for bad in ("../x", "a/b", "", "_models", ".hidden", "x" * 41, None, 3):
        assert _refuses(_round_name, bad), bad
    assert _round_name("lote-2_a") == "lote-2_a"

    good = JPEG_DATA_URL + base64.b64encode(_jpeg()).decode()
    assert _decode_jpeg(good) == _jpeg()
    png = JPEG_DATA_URL + base64.b64encode(_jpeg("PNG")).decode()
    for bad in (png, "data:image/png;base64,AAAA", JPEG_DATA_URL + "not base64!", JPEG_DATA_URL + "AAAA", None):
        assert _refuses(_decode_jpeg, bad), str(bad)[:40]


def test_roboflow_errors_never_carry_the_key():
    import requests
    import roboflowClient

    def fail(method, url, params=None, **kwargs):
        raise requests.ConnectionError(f"Max retries exceeded with url: {url}?api_key={params['api_key']}")

    real, roboflowClient.requests.request = roboflowClient.requests.request, fail
    try:
        client = roboflowClient.Roboflow({"ROBOFLOW_API_KEY": "SECRET123", "ROBOFLOW_PROJECT": "p"})
        try:
            client.versions()
        except roboflowClient.RoboflowError as e:
            assert "SECRET123" not in str(e) and "***" in str(e)
        else:
            raise AssertionError("no error")
    finally:
        roboflowClient.requests.request = real
    assert _refuses(_version_name, "../v1") and _refuses(_version_name, "3") and _version_name("v12") == "v12"


def test_canceled_process_is_not_reported_as_done():
    from pathlib import Path

    from labelerNode import Job, LabelerNode

    job = Job("train", "Train on v1")
    job.cancel.set()  # as cancel_job does; the process then exits on SIGINT
    try:
        LabelerNode._run_process(None, job, [sys.executable, "-c", "raise SystemExit(130)"], Path(tempfile.gettempdir()))
    except RuntimeError as e:
        assert str(e) == "Canceled"
    else:
        raise AssertionError("a canceled process returned normally, so the job would claim it finished")


def test_training_replaces_the_model_only_when_it_finishes():
    import time
    from pathlib import Path

    import rclpy

    import labelerNode

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / "_versions" / "v1").mkdir(parents=True)
        (root / "_versions" / "v1" / "data.yaml").write_text("")
        best = root / "_models" / "v1" / "weights" / "best.pt"
        best.parent.mkdir(parents=True)
        best.write_text("good")
        # Stands in for labelerTrain.py: writes best.pt in --project/--name, then fails when --epochs is 13.
        fake = root / "fake_train.py"
        fake.write_text("import pathlib, sys\na = sys.argv\n"
                        "w = pathlib.Path(a[a.index('--project') + 1]) / a[a.index('--name') + 1] / 'weights'\n"
                        "w.mkdir(parents=True, exist_ok=True)\n(w / 'best.pt').write_text('new')\n"  # exist_ok, as ultralytics
                        "sys.exit(a[a.index('--epochs') + 1] == '13')\n")
        real, labelerNode.TRAIN_SCRIPT = labelerNode.TRAIN_SCRIPT, fake
        # Domain 77: a labeler_node on the default domain would answer the running web client.
        rclpy.init(args=["--ros-args", "-p", f"root:={root}"], domain_id=77)
        node = labelerNode.LabelerNode()
        try:
            def train(epochs):
                node._handle_train({"version": "v1", "epochs": epochs})
                while node._job.state == "running":
                    time.sleep(0.05)
                return node._job.state

            assert train(13) == "failed" and best.read_text() == "good"
            assert train(2) == "done" and best.read_text() == "new"
            assert sorted(p.name for p in (root / "_models").iterdir()) == ["v1"]  # no v1.part left
        finally:
            labelerNode.TRAIN_SCRIPT = real
            node.destroy_node()
            rclpy.shutdown()


if __name__ == "__main__":
    test_save_writes_images_and_lists_them()
    test_refuses_bad_input_from_the_page()
    test_roboflow_errors_never_carry_the_key()
    test_canceled_process_is_not_reported_as_done()
    test_training_replaces_the_model_only_when_it_finishes()
    print("ok")
