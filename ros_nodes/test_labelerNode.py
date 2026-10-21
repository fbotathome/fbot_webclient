"""Checks the labeler's COCO dataset writing and the validation of the page's objects.
Run with the ROS environment sourced: python3 ros_nodes/test_labelerNode.py (or pytest)."""
import json
import os
import sys
import tempfile

from PIL import Image

sys.path.insert(0, os.path.dirname(__file__))
from labelerNode import Dataset, _parse_objects  # noqa: E402


def test_save_writes_coco_and_lists_it():
    with tempfile.TemporaryDirectory() as root:
        # A Roboflow export already there: its superclass has no boxes, so it is no class.
        os.makedirs(os.path.join(root, "train"))
        with open(os.path.join(root, "train", "_annotations.coco.json"), "w") as f:
            json.dump({"images": [], "annotations": [],
                       "categories": [{"id": 0, "name": "objects-xyz", "supercategory": "none"}]}, f)

        dataset = Dataset(root)
        frame = Image.new("RGB", (200, 100))
        item = dataset.add(frame, [{"label": "cup", "box": [0.1, 0.2, 0.3, 0.6]},
                                   {"label": "mug", "box": [0.5, 0.5, 1.0, 1.0]}], "train")
        assert item["labels"] == ["cup", "mug"] and not item["saved"]

        saved, errors = dataset.save([item["id"]])
        assert errors == [] and len(saved) == 1
        assert os.path.isfile(saved[0]["path"])

        with open(os.path.join(root, "train", "_annotations.coco.json")) as f:
            coco = json.load(f)
        names = {c["id"]: c["name"] for c in coco["categories"]}
        assert [names[a["category_id"]] for a in coco["annotations"]] == ["cup", "mug"]
        assert coco["annotations"][0]["bbox"] == [20.0, 20.0, 40.0, 40.0]
        assert coco["images"][0]["width"] == 200 and coco["images"][0]["height"] == 100
        assert dataset.classes() == ["cup", "mug"]

        # A second capture reuses "cup" and gets new image and annotation ids.
        item = dataset.add(frame, [{"label": "cup", "box": [0.0, 0.0, 0.5, 0.5]}], "train")
        assert dataset.save([item["id"]])[1] == []
        with open(os.path.join(root, "train", "_annotations.coco.json")) as f:
            coco = json.load(f)
        assert len(coco["categories"]) == 3 and [i["id"] for i in coco["images"]] == [1, 2]
        assert [a["id"] for a in coco["annotations"]] == [1, 2, 3]

        items, total = dataset.page(0)
        assert total == 2 and all(i["saved"] for i in items)
        assert [i["labels"] for i in items] == [["cup", "mug"], ["cup"]]


def test_parse_objects_rejects_bad_input():
    assert _parse_objects([{"label": " cup ", "box": [0, 0, 1, 1]}]) == [{"label": "cup", "box": [0.0, 0.0, 1.0, 1.0]}]
    assert _parse_objects([]) == []
    for bad in (None, [{"label": "", "box": [0, 0, 1, 1]}], [{"label": "cup", "box": [0.5, 0, 0.2, 1]}],
                [{"label": "cup", "box": [0, 0, 1.5, 1]}], [{"label": "cup", "box": [0, 0, 1]}]):
        try:
            _parse_objects(bad)
        except ValueError:
            continue
        raise AssertionError(f"accepted {bad}")


if __name__ == "__main__":
    test_save_writes_coco_and_lists_it()
    test_parse_objects_rejects_bad_input()
    print("ok")
