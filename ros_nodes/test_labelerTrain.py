"""Checks the two conversions labelerTrain.py makes without the model: Roboflow's data.yaml to
absolute paths, and the model's polygons to a COCO annotation for Roboflow.
Run: python3 ros_nodes/test_labelerTrain.py (or pytest)."""
import os
import sys
import tempfile
from pathlib import Path

import yaml

sys.path.insert(0, os.path.dirname(__file__))
from labelerTrain import absolute_data_yaml, coco_for_image  # noqa: E402


def test_data_yaml_gets_absolute_paths():
    with tempfile.TemporaryDirectory() as d:
        root = Path(d)
        (root / "train" / "images").mkdir(parents=True)
        (root / "data.yaml").write_text("train: ../train/images\nval: ../valid/images\ntest: ../test/images\n"
                                        "nc: 2\nnames: ['cup', 'mug']\n")
        data = yaml.safe_load(absolute_data_yaml(root / "data.yaml").read_text())
        # No valid/ in the export: validate on train; no test/: dropped.
        assert data["train"] == data["val"] == str(root / "train" / "images") and "test" not in data
        assert data["names"] == ["cup", "mug"]


def test_coco_for_image():
    square = [(10, 20), (50, 20), (50, 60), (10, 60)]
    border_line = [(639, 203), (639, 244), (639, 230), (639, 210)]  # a mask's contour along the photo's edge
    coco = coco_for_image("1.jpg", 640, 480, {0: "cup", 1: "mug"},
                          [(1, square), (0, [(1, 1), (2, 2)]), (0, border_line), (0, [])])
    assert coco["images"] == [{"id": 1, "file_name": "1.jpg", "width": 640, "height": 480}]
    assert [c["name"] for c in coco["categories"]] == ["cup", "mug"]
    (ann,) = coco["annotations"]  # the 2-point "polygon", the line and the empty one are dropped
    assert ann["category_id"] == 2 and ann["bbox"] == [10, 20, 40, 40] and ann["area"] == 1600
    assert ann["segmentation"] == [[10, 20, 50, 20, 50, 60, 10, 60]] and ann["iscrowd"] == 0


if __name__ == "__main__":
    test_data_yaml_gets_absolute_paths()
    test_coco_for_image()
    print("ok")
