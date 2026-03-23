import { ros } from "./ros.js";

let _viewer = null;
let _gridClient = null;

export function initMap(containerId = 'map') {
  const container = document.getElementById(containerId);
  if (!container) {
    throw new Error(`Container '#${containerId}' not found`);
  }

  _viewer = new ROS2D.Viewer({
    divID: 'map',
    width: container.clientWidth,
    height: container.clientHeight
  });

  _gridClient = new ROS2D.OccupancyGridClient({
    ros: ros,
    rootObject: _viewer.scene,
    continuous: true
  });

  _gridClient.on('change', function() {
    _viewer.scaleToDimensions(
      _gridClient.currentGrid.width,
      _gridClient.currentGrid.height
    );
    _viewer.shift(
      _gridClient.currentGrid.pose.position.x,
      _gridClient.currentGrid.pose.position.y
    );
  });
};

export function resizeMap(width, height) {
  if (!_viewer) {
    return;
  }
  _viewer.width = width;
  _viewer.height = height;

}

export function destroyMap() {
  if (_gridClient) {
    _gridClient.unsubscribe();
    _gridClient = null;
  }
  _viewer = null
}

export function getViewer() {
  return _viewer;
}
