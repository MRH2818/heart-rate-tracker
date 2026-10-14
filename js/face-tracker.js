import { FaceLandmarker, FilesetResolver } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.0";

export class FaceTracker {
  constructor() {
    this.landmarker = null;
    this.isReady = false;
    this.showOverlay = true;
    this.lastTimestamp = -1;

    // Landmark indices covering the central/upper forehead
    // Landmark 10: Top center forehead
    // Landmarks 109, 67, 108: Left upper forehead
    // Landmarks 338, 297, 337: Right upper forehead
    // Landmarks 151, 9, 8: Glabella / Mid forehead between eyebrows
    this.foreheadLandmarkIndices = [109, 67, 108, 151, 337, 297, 338, 10];
  }

  /**
   * Initializes the MediaPipe FaceLandmarker via official CDN assets
   */
  async initialize() {
    try {
      const filesetResolver = await FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.0/wasm"
      );

      this.landmarker = await FaceLandmarker.createFromOptions(filesetResolver, {
        baseOptions: {
          modelAssetPath: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
          delegate: "GPU"
        },
        runningMode: "VIDEO",
        numFaces: 1,
        minFaceDetectionConfidence: 0.5,
        minFacePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5
      });

      this.lastTimestamp = -1;
      this.isReady = true;
      return true;
    } catch (err) {
      console.error("Failed to initialize MediaPipe FaceLandmarker:", err);
      throw err;
    }
  }

  /**
   * Processes a video frame and returns the detected forehead ROI coordinates
   * @param {HTMLVideoElement} videoElement 
   * @param {number} timestampMs 
   * @returns {Object|null} ROI data { polygon: [{x, y}], bounds: {x, y, width, height} } or null
   */
  detectForeheadROI(videoElement, timestampMs) {
    if (!this.isReady || !this.landmarker || videoElement.readyState < 2) {
      return null;
    }

    // MediaPipe requires strictly monotonically increasing timestamps
    if (timestampMs <= this.lastTimestamp) {
      return null;
    }
    this.lastTimestamp = timestampMs;

    let results = null;
    try {
      results = this.landmarker.detectForVideo(videoElement, timestampMs);
    } catch (err) {
      console.warn("FaceLandmarker detectForVideo error:", err);
      return null;
    }

    if (!results || !results.faceLandmarks || results.faceLandmarks.length === 0) {
      return null;
    }

    const landmarks = results.faceLandmarks[0];
    const width = videoElement.videoWidth;
    const height = videoElement.videoHeight;

    // Convert normalized landmarks [0, 1] to pixel coordinates
    const polygon = this.foreheadLandmarkIndices.map(idx => {
      const pt = landmarks[idx];
      return {
        x: pt.x * width,
        y: pt.y * height
      };
    });

    // Compute bounding box of the forehead ROI
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    polygon.forEach(pt => {
      if (pt.x < minX) minX = pt.x;
      if (pt.x > maxX) maxX = pt.x;
      if (pt.y < minY) minY = pt.y;
      if (pt.y > maxY) maxY = pt.y;
    });

    // Clamp bounding box to video dimensions
    minX = Math.max(0, Math.floor(minX));
    minY = Math.max(0, Math.floor(minY));
    const roiWidth = Math.min(width - minX, Math.ceil(maxX - minX));
    const roiHeight = Math.min(height - minY, Math.ceil(maxY - minY));

    return {
      polygon,
      bounds: {
        x: minX,
        y: minY,
        width: roiWidth,
        height: roiHeight
      },
      allLandmarks: landmarks
    };
  }

  /**
   * Draws the forehead ROI polygon onto the overlay canvas
   * @param {CanvasRenderingContext2D} ctx 
   * @param {Object|null} roiData 
   * @param {number} canvasWidth 
   * @param {number} canvasHeight 
   */
  renderOverlay(ctx, roiData, canvasWidth, canvasHeight) {
    ctx.clearRect(0, 0, canvasWidth, canvasHeight);

    if (!this.showOverlay || !roiData || !roiData.polygon || roiData.polygon.length === 0) {
      return;
    }

    const poly = roiData.polygon;

    ctx.save();
    // Glowing cyan/green stroke for ROI
    ctx.strokeStyle = "#00e5a3";
    ctx.lineWidth = 2.5;
    ctx.fillStyle = "rgba(0, 229, 163, 0)";
    ctx.shadowColor = "rgba(0, 229, 163, 0.6)";
    ctx.shadowBlur = 8;

    ctx.beginPath();
    ctx.moveTo(poly[0].x, poly[0].y);
    for (let i = 1; i < poly.length; i++) {
      ctx.lineTo(poly[i].x, poly[i].y);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Draw small corner markers for visual polish
    ctx.fillStyle = "#ffffff";
    poly.forEach(pt => {
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 2.5, 0, Math.PI * 2);
      ctx.fill();
    });

    ctx.restore();
  }
}
