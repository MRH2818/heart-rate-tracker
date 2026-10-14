import { FaceTracker } from "./face-tracker.js";
import { RPPGProcessor } from "./rppg.js";
import { WaveformVisualizer, FFTVisualizer, HeartRateHistoryVisualizer } from "./visualizer.js";
import { HeartSwell } from "./heart-swell.js";

class HeartRateApp {
  /**
   * Initializes the application, caches DOM elements, creates engine instances,
   * binds event listeners, and renders the initial visualizer canvas.
   * 
   * Called by:
   * - Window "DOMContentLoaded" event listener (`new HeartRateApp()`).
   */
  constructor() {
    this.video = document.getElementById("webcam");
    this.overlayCanvas = document.getElementById("overlay-canvas");
    this.overlayCtx = this.overlayCanvas.getContext("2d");
    this.raw_waveformCanvas = document.getElementById("raw-waveform-canvas");
    this.filtered_waveformCanvas = document.getElementById("filtered-waveform-canvas");
    this.fft_waveformCanvas = document.getElementById("fft-canvas");
    this.hrHistoryCanvas = document.getElementById("hr-history-canvas");

    // UI Badges & Buttons
    this.fpsBadge = document.getElementById("fps-badge");
    this.statusBadge = document.getElementById("status-badge");
    this.bpmValue = document.getElementById("bpm-value");
    this.snrValue = document.getElementById("snr-value");
    this.freqValue = document.getElementById("freq-value");
    this.bufferProgress = document.getElementById("buffer-progress");
    this.algoValue = document.getElementById("algo-value");
    this.guidanceText = document.getElementById("guidance-text");
    this.cameraPlaceholder = document.getElementById("camera-placeholder");

    // Heart Rate Over Time Stats Readouts
    this.hrStatMin = document.getElementById("hr-stat-min");
    this.hrStatAvg = document.getElementById("hr-stat-avg");
    this.hrStatMax = document.getElementById("hr-stat-max");
    this.hrStatCur = document.getElementById("hr-stat-cur");

    this.btnToggleCamera = document.getElementById("btn-toggle-camera");
    this.btnToggleRoi = document.getElementById("btn-toggle-roi");
    this.btnResetConfig = document.getElementById("btn-reset-config");

    // Config Sliders & Displays
    this.inputWindowDuration = document.getElementById("input-window-duration");
    this.inputUpdateInterval = document.getElementById("input-update-interval");
    this.valWindowDuration = document.getElementById("val-window-duration");
    this.valUpdateInterval = document.getElementById("val-update-interval");
    this.selectAlgorithm = document.getElementById("select-algorithm");

    const initialAlgo = this.selectAlgorithm ? this.selectAlgorithm.value : "pos";

    // Core Processing Engines
    this.faceTracker = new FaceTracker();
    this.rppgProcessor = new RPPGProcessor({
      windowDurationSec: Number(this.inputWindowDuration.value),
      updateIntervalSec: Number(this.inputUpdateInterval.value),
      algorithm: initialAlgo
    });
    const initialWindowSec = Number(this.inputWindowDuration.value) || 8;
    this.raw_visualizer = new WaveformVisualizer(this.raw_waveformCanvas, {
      strokeColor: "#00d2ff",
      shadowColor: "rgba(0, 210, 255, 0.75)",
      lockBaseline: initialAlgo === "green",
      timeWindowSec: initialWindowSec
    });
    this.filtered_visualizer = new WaveformVisualizer(this.filtered_waveformCanvas, {
      strokeColor: "#00e5a3",
      shadowColor: "rgba(0, 229, 163, 0.75)",
      lockBaseline: false,
      timeWindowSec: initialWindowSec
    });
    this.fft_visualizer = new FFTVisualizer(this.fft_waveformCanvas);
    this.hrHistoryVisualizer = new HeartRateHistoryVisualizer(this.hrHistoryCanvas, {
      timeWindowSec: 60,
      strokeColor: "#ff3b69",
      glowColor: "rgba(255, 59, 105, 0.65)"
    });
    this.heartSwell = new HeartSwell(".pulse-icon");

    // State Variables
    this.isStreaming = false;
    this.stream = null;
    this.animationFrameId = null;
    this.lastFrameTime = 0;
    this.frameCount = 0;
    this.fpsTimer = performance.now();
    this.lastBpmRecordTime = 0;

    this.bindEvents();
    this.updateAlgorithmLabels(initialAlgo);
    this.raw_visualizer.draw();
    this.filtered_visualizer.draw();
    this.fft_visualizer.draw();
    this.hrHistoryVisualizer.draw();
  }

  /**
   * Binds UI click and input event listeners for controls and sliders.
   * 
   * Called by:
   * - `HeartRateApp.constructor()` during application setup.
   */
  bindEvents() {
    this.btnToggleCamera.addEventListener("click", () => this.toggleCamera());

    this.btnToggleRoi.addEventListener("click", () => {
      this.faceTracker.showOverlay = !this.faceTracker.showOverlay;
      this.btnToggleRoi.textContent = this.faceTracker.showOverlay ? "Hide Overlay" : "Show Overlay";
    });

    this.inputWindowDuration.addEventListener("input", (e) => {
      const val = Number(e.target.value);
      this.valWindowDuration.textContent = val;
      this.bufferProgress.textContent = val + "s";
      this.rppgProcessor.setConfig({ windowDurationSec: val });
      this.raw_visualizer.setTimeWindow(val);
      this.filtered_visualizer.setTimeWindow(val);
    });

    this.inputUpdateInterval.addEventListener("input", (e) => {
      const val = Number(e.target.value).toFixed(1);
      this.valUpdateInterval.textContent = val;
      this.rppgProcessor.setConfig({ updateIntervalSec: Number(val) });
    });

    if (this.selectAlgorithm) {
      this.selectAlgorithm.addEventListener("change", (e) => {
        const algo = e.target.value;
        this.rppgProcessor.setConfig({ algorithm: algo });
        this.raw_visualizer.setLockBaseline(algo === "green");
        this.raw_visualizer.clear();
        this.filtered_visualizer.clear();
        this.hrHistoryVisualizer.clear();
        this.resetHrStats();
        this.updateAlgorithmLabels(algo);
      });
    }

    this.btnResetConfig.addEventListener("click", () => {
      this.inputWindowDuration.value = 8;
      this.valWindowDuration.textContent = "8";
      this.inputUpdateInterval.value = 1.0;
      this.valUpdateInterval.textContent = "1.0";
      if (this.selectAlgorithm) {
        this.selectAlgorithm.value = "pos";
      }
      this.rppgProcessor.setConfig({ windowDurationSec: 8, updateIntervalSec: 1.0, algorithm: "pos" });
      this.raw_visualizer.setLockBaseline(false);
      this.raw_visualizer.setTimeWindow(8);
      this.filtered_visualizer.setTimeWindow(8);
      this.raw_visualizer.clear();
      this.filtered_visualizer.clear();
      this.hrHistoryVisualizer.clear();
      this.resetHrStats();
      this.updateAlgorithmLabels("pos");
    });
  }

  /**
   * Resets heart rate history statistics display
   */
  resetHrStats() {
    this.lastBpmRecordTime = 0;
    if (this.hrStatMin) this.hrStatMin.textContent = "--";
    if (this.hrStatAvg) this.hrStatAvg.textContent = "--";
    if (this.hrStatMax) this.hrStatMax.textContent = "--";
    if (this.hrStatCur) this.hrStatCur.textContent = "--";
  }

  /**
   * Updates chart titles, legend descriptions, and vitals badge to match selected algorithm.
   * @param {string} algo - "pos" | "green"
   */
  updateAlgorithmLabels(algo) {
    const rawTitle = document.getElementById("raw-chart-title");
    const rawDesc = document.getElementById("raw-chart-desc");
    const filteredTitle = document.getElementById("filtered-chart-title");
    const filteredDesc = document.getElementById("filtered-chart-desc");

    if (algo === "pos") {
      if (rawTitle) rawTitle.textContent = "Live Optical Pulse Waveform (RAW POS Signal)";
      if (rawDesc) rawDesc.textContent = "Plane-Orthogonal-to-Skin Projection (no passband)";
      if (filteredTitle) filteredTitle.textContent = "Live Optical Pulse Waveform (Filtered POS Signal)";
      if (filteredDesc) filteredDesc.textContent = "POS Pulse Wave (45–180 BPM passband)";
      if (this.algoValue) this.algoValue.textContent = "POS";
    } else {
      if (rawTitle) rawTitle.textContent = "Live Optical Pulse Waveform (RAW Green Channel)";
      if (rawDesc) rawDesc.textContent = "Spatial Green Averaging (no passband)";
      if (filteredTitle) filteredTitle.textContent = "Live Optical Pulse Waveform (Filtered Green Channel)";
      if (filteredDesc) filteredDesc.textContent = "Green Channel (45–180 BPM passband)";
      if (this.algoValue) this.algoValue.textContent = "Green";
    }
  }

  /**
   * Toggles the webcam video feed and optical pulse tracking on or off.
   * 
   * Called by:
   * - `btnToggleCamera` click event ("Start Camera" / "Stop Camera" button).
   */
  async toggleCamera() {
    if (this.isStreaming) {
      this.stopCamera();
    } else {
      await this.startCamera();
    }
  }

  /**
   * Initializes FaceLandmarker, requests webcam access, synchronizes canvas resolution,
   * resets processors, and initiates the real-time processing loop.
   * 
   * Called by:
   * - `this.toggleCamera()` when webcam is not currently active (`!this.isStreaming`).
   */
  async startCamera() {
    this.updateStatus("Initializing...", "calibrating");
    this.guidanceText.textContent = "Loading MediaPipe Face Mesh model and requesting camera permissions...";

    try {
      // 1. Initialize MediaPipe FaceLandmarker if not already ready
      if (!this.faceTracker.isReady) {
        await this.faceTracker.initialize();
      }

      // 2. Request webcam video stream
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 640 },
          height: { ideal: 480 },
          frameRate: { ideal: 30 }
        },
        audio: false
      });

      this.video.srcObject = this.stream;

      await new Promise((resolve) => {
        this.video.onloadedmetadata = () => {
          this.video.play();
          resolve();
        };
      });

      // Synchronize canvas size to video resolution
      this.overlayCanvas.width = this.video.videoWidth;
      this.overlayCanvas.height = this.video.videoHeight;

      this.isStreaming = true;
      this.cameraPlaceholder.style.display = "none";
      this.btnToggleCamera.textContent = "Stop Camera";
      this.btnToggleCamera.classList.remove("btn-primary");
      this.btnToggleCamera.classList.add("btn-danger");

      this.updateStatus("Calibrating...", "calibrating");
      this.guidanceText.textContent = "Keep your head steady and align your forehead inside the highlighted region.";

      // 3. Start processing loop
      this.rppgProcessor.reset();
      this.raw_visualizer.clear();
      this.filtered_visualizer.clear();
      this.fft_visualizer.clear();
      this.hrHistoryVisualizer.clear();
      this.resetHrStats();
      this.fpsTimer = performance.now();
      this.frameCount = 0;
      this.lastFrameTime = performance.now();

      this.animationFrameId = requestAnimationFrame((ts) => this.processLoop(ts));
    } catch (err) {
      console.error("Camera startup failed:", err);
      this.updateStatus("Camera Error", "warning");
      this.guidanceText.textContent = `Could not start camera: ${err.message}. Please verify webcam permissions.`;
      this.stopCamera();
    }
  }

  /**
   * Stops active camera video tracks, cancels pending animation frames,
   * clears the overlay canvas, resets signal buffers, and restores idle UI state.
   * 
   * Called by:
   * - `this.toggleCamera()` when webcam is active (`this.isStreaming`).
   * - `this.startCamera()` catch block if camera startup or permissions fail.
   */
  stopCamera() {
    this.isStreaming = false;

    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }

    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }

    this.video.srcObject = null;
    this.overlayCtx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
    this.cameraPlaceholder.style.display = "flex";

    this.btnToggleCamera.textContent = "Start Camera";
    this.btnToggleCamera.classList.remove("btn-danger");
    this.btnToggleCamera.classList.add("btn-primary");

    this.updateStatus("Ready", "idle");
    this.fpsBadge.textContent = "0 FPS";
    this.bpmValue.textContent = "--";
    this.snrValue.textContent = "--";
    this.freqValue.textContent = "-- Hz";
    this.bufferProgress.textContent = this.inputWindowDuration.value + "s";
    if (this.algoValue) {
      this.algoValue.textContent = (this.selectAlgorithm ? this.selectAlgorithm.value : "pos").toUpperCase();
    }
    this.guidanceText.textContent = 'Click "Start Camera" to begin face detection and optical pulse tracking.';

    this.rppgProcessor.reset();
    this.heartSwell.stop();
    this.raw_visualizer.clear();
    this.filtered_visualizer.clear();
    this.fft_visualizer.clear();
    this.hrHistoryVisualizer.clear();
    this.resetHrStats();
  }

  /**
   * Main animation and frame processing loop. Detects forehead ROI, processes
   * rPPG signal, calculates heart rate metrics, and renders oscilloscope waveform.
   * 
   * Called by:
   * - `this.startCamera()` to kick off the frame processing loop.
   * - `window.requestAnimationFrame()` recursively on every animation frame while streaming.
   * 
   * @param {number} timestamp - DOMHighResTimeStamp passed by requestAnimationFrame.
   */
  processLoop(timestamp) {
    if (!this.isStreaming) return;

    // Measure FPS
    this.frameCount++;
    if (timestamp - this.fpsTimer >= 500) {
      const currentFps = Math.round((this.frameCount * 1000) / (timestamp - this.fpsTimer));
      this.fpsBadge.textContent = `${currentFps} FPS`;
      this.frameCount = 0;
      this.fpsTimer = timestamp;
    }

    // 1. Detect forehead ROI via MediaPipe FaceLandmarker
    const roiData = this.faceTracker.detectForeheadROI(this.video, timestamp);

    // 2. Render ROI polygon on overlay canvas
    this.faceTracker.renderOverlay(
      this.overlayCtx,
      roiData,
      this.overlayCanvas.width,
      this.overlayCanvas.height
    );

    // 3. Process optical signal if forehead is tracked
    if (roiData) {
      const result = this.rppgProcessor.processFrame(this.video, roiData, timestamp);

      if (result) {
        this.bufferProgress.textContent = `${result.bufferProgress}s`;

        // Update pulse waveforms in visualizers on every animation frame
        if (result.rawPoint !== undefined) {
          this.raw_visualizer.addPoint(result.rawPoint, timestamp);
        }
        if (result.filteredPoint !== undefined) {
          this.filtered_visualizer.addPoint(result.filteredPoint, timestamp);
        }

        // Update BPM and spectral metrics when available
        const bpmResult = result.bpmResult;
        if (bpmResult && bpmResult.spectrum) {
          this.fft_visualizer.setData(bpmResult);
        }
        if (bpmResult && bpmResult.bpm) {
          if (bpmResult.algorithm && this.algoValue) {
            this.algoValue.textContent = bpmResult.algorithm.toUpperCase();
          }
          this.bpmValue.textContent = bpmResult.bpm;
          this.snrValue.textContent = `${bpmResult.snrDb > 0 ? "+" : ""}${bpmResult.snrDb} dB`;
          this.freqValue.textContent = `${bpmResult.frequencyHz} Hz`;

          // Synchronize heart swell animation to the scheduled systolic peak
          if (bpmResult.nextBeatTimestamp) {
            this.heartSwell.nextBeatUpdate(bpmResult.nextBeatTimestamp, bpmResult.bpm, timestamp);
          } else {
            this.heartSwell.nextBeatUpdate(timestamp, bpmResult.bpm, timestamp);
          }

          if (bpmResult.confidence === "high") {
            this.updateStatus("Signal Stable", "stable");
            this.guidanceText.textContent = "Pulse signal locked. Maintain steady posture.";
          } else if (bpmResult.confidence === "moderate") {
            this.updateStatus("Moderate Signal", "calibrating");
            this.guidanceText.textContent = "Pulse detected. Hold still for improved accuracy.";
          } else {
            this.updateStatus("Low Signal", "warning");
            this.guidanceText.textContent = "Signal noisy. Ensure forehead is well lit and avoid smiling/moving.";
          }

          // Record heart rate over time (throttled to updateIntervalSec or min 400ms)
          const minRecordInterval = Math.max(400, (this.rppgProcessor.updateIntervalSec * 1000) * 0.85);
          if (timestamp - this.lastBpmRecordTime >= minRecordInterval) {
            this.hrHistoryVisualizer.addPoint(bpmResult.bpm, timestamp, bpmResult.confidence);
            this.lastBpmRecordTime = timestamp;

            const stats = this.hrHistoryVisualizer.getStats();
            if (stats.count > 0) {
              if (this.hrStatMin) this.hrStatMin.textContent = stats.min;
              if (this.hrStatAvg) this.hrStatAvg.textContent = stats.avg;
              if (this.hrStatMax) this.hrStatMax.textContent = stats.max;
              if (this.hrStatCur) this.hrStatCur.textContent = `${stats.current} BPM`;
            }
          }
        } else {
          this.updateStatus(`Calibrating (${result.bufferProgress}s)`, "calibrating");
          this.guidanceText.textContent = `Filling rolling buffer... Hold still for initial reading.`;
        }
      }
    } else {
      // Face was not detected in this frame
      this.updateStatus("No Face Detected", "warning");
      this.guidanceText.textContent = "Position your face so your forehead is clearly visible in the camera.";
    }

    // Redraw waveform oscilloscope, FFT spectrum distribution, and heart rate history
    this.raw_visualizer.draw();
    this.filtered_visualizer.draw();
    this.fft_visualizer.draw();
    this.hrHistoryVisualizer.draw();

    // Schedule next frame
    this.animationFrameId = requestAnimationFrame((ts) => this.processLoop(ts));
  }

  /**
   * Updates the UI status badge text and CSS badge variant.
   * 
   * Called by:
   * - `this.startCamera()` during initialization and calibration.
   * - `this.stopCamera()` when resetting to ready or reporting an error.
   * - `this.processLoop()` on face detection status and pulse signal quality updates.
   * 
   * @param {string} text - Status label text.
   * @param {string} type - Badge style variant ("idle", "calibrating", "stable", "warning").
   */
  updateStatus(text, type) {
    this.statusBadge.textContent = text;
    this.statusBadge.className = `badge badge-${type}`;
  }
}

/**
 * Application entry point: initializes HeartRateApp once the DOM tree is loaded.
 * 
 * Called by:
 * - Browser runtime on the window "DOMContentLoaded" event.
 */
window.addEventListener("DOMContentLoaded", () => {
  new HeartRateApp();
});
