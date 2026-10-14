export class WaveformVisualizer {
  /**
   * @param {HTMLCanvasElement} canvas 
   * @param {Object} [options]
   * @param {number} [options.maxPoints=360] - Buffer size for rolling waveform.
   * @param {number} [options.timeWindowSec=8] - Rolling duration window in seconds for the X-axis time scale.
   * @param {boolean} [options.showTimeScale=true] - Whether to show the horizontal X-axis time values.
   * @param {string} [options.strokeColor="#00e5a3"] - Waveform stroke color.
   * @param {string} [options.shadowColor="rgba(0, 229, 163, 0.75)"] - Waveform glow color.
   * @param {string} [options.baselineColor="rgba(0, 210, 255, 0.35)"] - Baseline line color.
   * @param {boolean} [options.lockBaseline=true] - Whether to lock the vertical axis baseline.
   * @param {number} [options.baselineValue=0] - Input variable specifying the locked baseline level.
   * @param {boolean} [options.showScale=true] - Whether to show the numeric Y-axis scale.
   * @param {number} [options.scaleWidth=48] - Width in pixels reserved for the number scale.
   */
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.timeWindowSec = options.timeWindowSec ?? 8;
    this.showTimeScale = options.showTimeScale ?? true;
    this.maxPoints = options.maxPoints ?? Math.max(360, this.timeWindowSec * 60);
    this.strokeColor = options.strokeColor ?? "#00e5a3";
    this.shadowColor = options.shadowColor ?? "rgba(0, 229, 163, 0.75)";
    this.baselineColor = options.baselineColor ?? "rgba(0, 210, 255, 0.35)";
    this.showScale = options.showScale ?? true;
    this.scaleWidth = options.scaleWidth ?? 48;
    this.dataPoints = []; // Rolling array of { value: number, t: number }

    // Auto-scaling state (vertical axis minimum locked at input variable baselineValue)
    this.lockBaseline = options.lockBaseline ?? options.lockBaselineAtZero ?? true;
    this.baselineValue = options.baselineValue ?? options.baseline ?? 0;
    if (this.lockBaseline) {
      this.smoothedMin = this.baselineValue;
      this.smoothedMax = this.baselineValue + 1;
    } else {
      this.smoothedMax = 1;
      this.smoothedMin = -1;
    }

    this.resizeCanvas();
    window.addEventListener("resize", () => this.resizeCanvas());
  }

  /**
   * Dynamically updates the time window duration in seconds
   * @param {number} sec - Time window duration in seconds
   */
  setTimeWindow(sec) {
    if (isNaN(sec) || sec <= 0) return;
    this.timeWindowSec = Number(sec);
    this.maxPoints = Math.max(this.maxPoints, this.timeWindowSec * 60);
    this.draw();
  }

  /**
   * Updates the baseline lock value dynamically
   * @param {number} value
   */
  setBaselineValue(value) {
    this.baselineValue = Number(value);
    if (this.lockBaseline) {
      this.smoothedMin = this.baselineValue;
    }
    this.draw();
  }

  setBaseline(value) {
    this.setBaselineValue(value);
  }

  /**
   * Toggles baseline locking behavior dynamically
   * @param {boolean} lock - True to lock baseline at baselineValue; false for symmetrical zero-centered scaling
   * @param {number} [baselineValue=0] - Target baseline level if locked
   */
  setLockBaseline(lock, baselineValue = 0) {
    this.lockBaseline = Boolean(lock);
    this.baselineValue = Number(baselineValue);
    if (this.lockBaseline) {
      this.smoothedMin = this.baselineValue;
      this.smoothedMax = this.baselineValue + 1;
    } else {
      this.smoothedMax = 1;
      this.smoothedMin = -1;
    }
    this.draw();
  }

  resizeCanvas() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.ctx.scale(dpr, dpr);
    this.displayWidth = rect.width;
    this.displayHeight = rect.height;
  }

  /**
   * Formats a numeric value cleanly for the vertical axis scale
   * @param {number} val
   * @returns {string}
   */
  formatScaleValue(val) {
    if (isNaN(val)) return "0";
    if (Math.abs(val) < 1e-5) return "0";
    const abs = Math.abs(val);
    if (abs >= 1000) return (val / 1000).toFixed(1) + "k";
    if (abs >= 100) return val.toFixed(0);
    if (abs >= 10) return val.toFixed(1);
    return val.toFixed(2);
  }

  /**
   * Computes clean time step intervals in seconds for the X-axis
   * @param {number} totalSec
   * @returns {number}
   */
  getTimeStep(totalSec) {
    if (totalSec <= 4) return 1;
    if (totalSec <= 10) return 2;
    if (totalSec <= 16) return (totalSec % 3 === 0) ? 3 : 2;
    return 5;
  }

  /**
   * Appends a new pulse amplitude point with optional timestamp
   * @param {number} value - Signal amplitude value
   * @param {number} [timestamp] - High-resolution millisecond timestamp
   */
  addPoint(value, timestamp = null) {
    if (isNaN(value)) return;
    const t = typeof timestamp === "number" ? timestamp : performance.now();
    this.dataPoints.push({ value: Number(value), t });

    // Prune points older than the time window + 1000ms buffer margin
    const cutoff = t - (this.timeWindowSec * 1000 + 1000);
    while (this.dataPoints.length > 0 && this.dataPoints[0].t < cutoff) {
      this.dataPoints.shift();
    }

    // Safety fallback cap on maximum points in memory
    const maxAllowed = Math.max(this.maxPoints, this.timeWindowSec * 120);
    if (this.dataPoints.length > maxAllowed) {
      this.dataPoints.shift();
    }
  }

  /**
   * Clears the current waveform points
   */
  clear() {
    this.dataPoints = [];
    this.draw();
  }

  /**
   * Redraws the waveform oscilloscope chart
   */
  draw() {
    const width = this.displayWidth || this.canvas.width;
    const height = this.displayHeight || this.canvas.height;
    const ctx = this.ctx;
    const numH = 6;
    const baselineY = ((numH - 1) * height) / numH;
    const topMargin = height / numH;
    const availableHeight = baselineY - topMargin;
    const plotLeft = this.showScale ? this.scaleWidth : 0;
    const plotWidth = width - plotLeft - 8;

    // 1. Clear background
    ctx.fillStyle = "#070a10";
    ctx.fillRect(0, 0, width, height);

    // 2. Dynamic auto-scaling of amplitude
    if (this.lockBaseline) {
      let currentMin = this.baselineValue;
      let currentMax = -Infinity;
      for (let i = 0; i < this.dataPoints.length; i++) {
        const pt = this.dataPoints[i];
        const v = typeof pt === "object" ? pt.value : pt;
        if (v > currentMax) currentMax = v;
      }

      if (!isFinite(currentMax) || currentMax <= currentMin) {
        currentMax = this.baselineValue < 0 ? 1 : currentMin + 1;
      }

      this.smoothedMin = this.baselineValue;
      if (!isFinite(this.smoothedMax)) this.smoothedMax = currentMax;
      this.smoothedMax += (currentMax - this.smoothedMax) * 0.1;
    } else {
      // 0 axis locked in the middle: symmetrical scaling around 0
      let maxAbs = 0;
      for (let i = 0; i < this.dataPoints.length; i++) {
        const pt = this.dataPoints[i];
        const v = typeof pt === "object" ? pt.value : pt;
        const abs = Math.abs(v);
        if (abs > maxAbs) maxAbs = abs;
      }

      if (!isFinite(maxAbs) || maxAbs < 1e-4) {
        maxAbs = 1;
      }

      if (!isFinite(this.smoothedMax) || this.smoothedMax <= 0) {
        this.smoothedMax = maxAbs;
      }
      this.smoothedMax += (maxAbs - this.smoothedMax) * 0.1;
      this.smoothedMin = -this.smoothedMax;
    }

    const range = Math.max(1e-4, this.smoothedMax - this.smoothedMin);

    // 3. Draw subtle background medical grid (including 0 axis line if baseline < 0)
    this.drawGrid(ctx, width, height, plotLeft, plotWidth, baselineY, availableHeight, range);

    // 4. Render vertical number scale (including 0 label if baseline < 0)
    this.drawScale(ctx, width, height, numH, baselineY, topMargin, range, plotLeft, availableHeight);

    // 5. Render horizontal X-axis time scale along baselineY
    this.drawTimeScale(ctx, width, height, plotLeft, plotWidth, baselineY);

    if (this.dataPoints.length < 2) {
      // Draw flat baseline when idle (locked at baselineValue on vertical axis, or middle if lockBaseline is false)
      const idleY = this.lockBaseline ? baselineY : (baselineY - 0.5 * availableHeight);
      ctx.strokeStyle = this.strokeColor;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(plotLeft, idleY);
      ctx.lineTo(plotLeft + plotWidth, idleY);
      ctx.stroke();
      return;
    }

    // 6. Render glowing pulse waveform
    ctx.save();
    ctx.strokeStyle = this.strokeColor;
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.shadowColor = this.shadowColor;
    ctx.shadowBlur = 10;

    // Use clip so waveform stays cleanly inside the plot area
    ctx.save();
    ctx.beginPath();
    ctx.rect(plotLeft, 0, plotWidth, baselineY + 1);
    ctx.clip();

    ctx.beginPath();
    const lastPt = this.dataPoints[this.dataPoints.length - 1];
    const tLatest = (typeof lastPt === "object" && typeof lastPt.t === "number")
      ? lastPt.t
      : performance.now();
    const windowMs = this.timeWindowSec * 1000;
    let hasMoved = false;

    for (let i = 0; i < this.dataPoints.length; i++) {
      const pt = this.dataPoints[i];
      const val = typeof pt === "object" ? pt.value : pt;
      const t = typeof pt === "object" ? pt.t : null;

      let x;
      if (typeof t === "number" && windowMs > 0) {
        const age = tLatest - t;
        const normX = 1 - (age / windowMs);
        x = plotLeft + normX * plotWidth;
      } else {
        const stepX = plotWidth / (this.maxPoints - 1);
        const startX = plotLeft + (this.maxPoints - this.dataPoints.length) * stepX;
        x = startX + i * stepX;
      }

      // Invert Y axis so higher blood volume / peak corresponds to upward wave
      const normalizedY = (val - this.smoothedMin) / range;
      const y = baselineY - normalizedY * availableHeight;

      // Break line if there was a gap > 1.2s (e.g. face tracking lost)
      if (i > 0 && typeof pt === "object" && typeof this.dataPoints[i - 1] === "object") {
        if (typeof pt.t === "number" && typeof this.dataPoints[i - 1].t === "number") {
          if (pt.t - this.dataPoints[i - 1].t > 1200) {
            ctx.moveTo(x, y);
            continue;
          }
        }
      }

      if (!hasMoved) {
        ctx.moveTo(x, y);
        hasMoved = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
    ctx.restore(); // restores clip
    ctx.restore(); // restores glowing stroke style
  }

  /**
   * Draws oscilloscope horizontal & vertical gridlines aligned with time intervals
   */
  drawGrid(ctx, width, height, plotLeft = 0, plotWidth = width, baselineY = 0, availableHeight = 0, range = 1) {
    ctx.save();
    ctx.lineWidth = 1;

    // Horizontal lines
    ctx.strokeStyle = "rgba(32, 45, 74, 0.4)";
    const numH = 6;
    for (let i = 1; i < numH; i++) {
      const y = (height / numH) * i;
      ctx.beginPath();
      ctx.moveTo(plotLeft, y);
      ctx.lineTo(plotLeft + plotWidth, y);
      ctx.stroke();
    }

    // Vertical time grid lines aligned to seconds
    const totalSec = Math.max(1, this.timeWindowSec);
    const timeStep = this.getTimeStep(totalSec);

    // Minor lines at 1-second intervals (if timeStep > 1)
    if (timeStep > 1) {
      ctx.strokeStyle = "rgba(32, 45, 74, 0.2)";
      for (let s = 1; s < totalSec; s++) {
        if (s % timeStep === 0) continue;
        const normX = 1 - (s / totalSec);
        const x = plotLeft + normX * plotWidth;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, baselineY);
        ctx.stroke();
      }
    }

    // Major lines at timeStep intervals
    ctx.strokeStyle = "rgba(32, 45, 74, 0.45)";
    for (let s = timeStep; s < totalSec; s += timeStep) {
      const normX = 1 - (s / totalSec);
      const x = plotLeft + normX * plotWidth;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, baselineY);
      ctx.stroke();
    }

    if (this.lockBaseline) {
      // Baseline locked at input baselineValue on the vertical axis (bottom grid line)
      ctx.strokeStyle = this.baselineColor ?? "rgba(0, 210, 255, 0.35)";
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(plotLeft, baselineY);
      ctx.lineTo(plotLeft + plotWidth, baselineY);
      ctx.stroke();

      // If baseline is locked below 0, draw distinct 0-axis line
      if (this.smoothedMin < 0 && this.smoothedMax > 0 && availableHeight > 0) {
        const normalizedZero = (0 - this.smoothedMin) / range;
        const zeroY = baselineY - normalizedZero * availableHeight;
        ctx.strokeStyle = "rgba(0, 210, 255, 0.5)";
        ctx.lineWidth = 1.25;
        ctx.setLineDash([6, 3]);
        ctx.beginPath();
        ctx.moveTo(plotLeft, zeroY);
        ctx.lineTo(plotLeft + plotWidth, zeroY);
        ctx.stroke();
      }
    } else {
      // 0 axis locked in the middle
      const zeroY = baselineY - 0.5 * availableHeight;
      ctx.strokeStyle = this.baselineColor ?? "rgba(0, 210, 255, 0.5)";
      ctx.lineWidth = 1.25;
      ctx.setLineDash([6, 3]);
      ctx.beginPath();
      ctx.moveTo(plotLeft, zeroY);
      ctx.lineTo(plotLeft + plotWidth, zeroY);
      ctx.stroke();
    }

    ctx.restore();
  }

  /**
   * Draws horizontal X-axis time scale along the bottom of the waveform plot
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} width
   * @param {number} height
   * @param {number} plotLeft
   * @param {number} plotWidth
   * @param {number} baselineY
   */
  drawTimeScale(ctx, width, height, plotLeft, plotWidth, baselineY) {
    if (!this.showTimeScale) return;

    ctx.save();

    // Horizontal axis line along baselineY
    ctx.strokeStyle = "rgba(45, 65, 100, 0.65)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(plotLeft, baselineY);
    ctx.lineTo(plotLeft + plotWidth, baselineY);
    ctx.stroke();

    // Time ticks and labels
    const totalSec = Math.max(1, this.timeWindowSec);
    const timeStep = this.getTimeStep(totalSec);

    ctx.font = '600 9px "SF Mono", "Roboto Mono", Consolas, monospace';
    ctx.textBaseline = "top";

    for (let s = 0; s <= totalSec; s += timeStep) {
      const normX = 1 - (s / totalSec);
      if (normX < -0.01 || normX > 1.01) continue;
      const x = plotLeft + normX * plotWidth;

      // Tick mark extending downward from baselineY
      ctx.strokeStyle = "rgba(100, 140, 190, 0.55)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, baselineY);
      ctx.lineTo(x, baselineY + 4);
      ctx.stroke();

      // Label text
      const isNow = s === 0;
      const isFarLeft = Math.abs(s - totalSec) < 1e-3;

      if (isNow) {
        ctx.textAlign = "right";
        ctx.fillStyle = this.strokeColor;
        ctx.fillText("Now", x, baselineY + 6);
      } else if (isFarLeft) {
        ctx.textAlign = "left";
        ctx.fillStyle = "rgba(160, 190, 230, 0.75)";
        ctx.fillText(`-${s}s`, x, baselineY + 6);
      } else {
        ctx.textAlign = "center";
        ctx.fillStyle = "rgba(160, 190, 230, 0.75)";
        ctx.fillText(`-${s}s`, x, baselineY + 6);
      }
    }

    ctx.restore();
  }

  /**
   * Draws the vertical numeric scale along the left edge
   */
  drawScale(ctx, width, height, numH, baselineY, topMargin, range, plotLeft, availableHeight = 0) {
    if (!this.showScale || plotLeft <= 0) return;
    ctx.save();
    ctx.font = '600 10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Roboto Mono", monospace';
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";

    // Subtle axis divider line separating numeric scale from waveform plot area
    ctx.strokeStyle = "rgba(45, 65, 100, 0.55)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(plotLeft, topMargin);
    ctx.lineTo(plotLeft, baselineY);
    ctx.stroke();

    // Check if 0-axis line is present within the chart
    const hasZeroLine = !this.lockBaseline || (this.smoothedMin < 0 && this.smoothedMax > 0 && availableHeight > 0);
    let zeroY = null;
    if (hasZeroLine) {
      const normalizedZero = (0 - this.smoothedMin) / range;
      zeroY = baselineY - normalizedZero * availableHeight;
    }

    for (let i = 1; i < numH; i++) {
      const y = (height / numH) * i;

      // Avoid text overlap if a gridline is within 12px of the 0 axis line
      if (zeroY !== null && Math.abs(y - zeroY) < 12) {
        continue;
      }

      const normalized = (numH - 1 - i) / (numH - 2);
      const val = this.smoothedMin + normalized * range;
      const label = this.formatScaleValue(val);

      // Tick mark
      ctx.strokeStyle = "rgba(100, 140, 190, 0.5)";
      ctx.beginPath();
      ctx.moveTo(plotLeft - 4, y);
      ctx.lineTo(plotLeft, y);
      ctx.stroke();

      // Number text
      if (i === numH - 1) {
        ctx.fillStyle = this.smoothedMin === 0 ? "#00d2ff" : "rgba(160, 190, 230, 0.85)";
      } else {
        ctx.fillStyle = "rgba(160, 190, 230, 0.75)";
      }
      ctx.fillText(label, plotLeft - 7, y);
    }

    // Explicitly render "0" with a prominent tick mark at zeroY if baseline is below 0
    if (zeroY !== null) {
      ctx.strokeStyle = "rgba(0, 210, 255, 0.8)";
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      ctx.moveTo(plotLeft - 5, zeroY);
      ctx.lineTo(plotLeft, zeroY);
      ctx.stroke();

      ctx.fillStyle = "#00d2ff";
      ctx.fillText("0", plotLeft - 7, zeroY);
    }

    ctx.restore();
  }
}

export class FFTVisualizer {
  /**
   * High-performance Fast Fourier Transform (FFT) spectrum distribution visualizer.
   * Renders the complete frequency distribution with vertical & horizontal numeric scales
   * and an integrated bottom bar indicating bin size, bin count, and peak spectral metrics.
   *
   * @param {HTMLCanvasElement} canvas - Target HTML canvas element.
   * @param {Object} [options]
   * @param {string} [options.strokeColor="#00d2ff"] - Primary contour stroke color.
   * @param {string} [options.glowColor="rgba(0, 210, 255, 0.6)"] - Glow color for peak contours.
   * @param {string} [options.peakColor="#ff3b69"] - Highlight color for dominant peak marker.
   * @param {string} [options.bandHighlightColor="rgba(0, 210, 255, 0.08)"] - Shading for pulse passband (0.75 - 3.0 Hz).
   * @param {boolean} [options.showScale=true] - Whether to show the vertical Y-axis numeric scale.
   * @param {number} [options.scaleWidth=52] - Pixel width reserved for Y-axis scale.
   * @param {boolean} [options.showBottomBar=true] - Whether to show the bottom bar with bin size and count.
   * @param {number} [options.bottomBarHeight=28] - Pixel height reserved for bottom status bar.
   * @param {boolean} [options.showXScale=true] - Whether to show horizontal X-axis frequency numbers.
   * @param {number} [options.xScaleHeight=20] - Pixel height reserved for X-axis frequency scale.
   * @param {string} [options.renderMode="both"] - Rendering style: "both" | "bars" | "curve".
   * @param {string} [options.unit="Hz"] - Frequency unit display label.
   */
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");

    // Styling & Layout Options
    this.strokeColor = options.strokeColor ?? "#00d2ff";
    this.secondaryColor = options.secondaryColor ?? "#00e5a3";
    this.glowColor = options.glowColor ?? "rgba(0, 210, 255, 0.6)";
    this.peakColor = options.peakColor ?? "#ff3b69";
    this.bandHighlightColor = options.bandHighlightColor ?? "rgba(0, 210, 255, 0.07)";
    this.showScale = options.showScale ?? true;
    this.scaleWidth = options.scaleWidth ?? 52;
    this.showBottomBar = options.showBottomBar ?? true;
    this.bottomBarHeight = options.bottomBarHeight ?? 28;
    this.showXScale = options.showXScale ?? true;
    this.xScaleHeight = options.xScaleHeight ?? 20;
    this.renderMode = options.renderMode ?? "both";
    this.unit = options.unit ?? "Hz";

    // Spectral Distribution Data State
    this.spectrum = null; // Float32Array or number[] of magnitudes across all bins
    this.binCount = 0; // Total count of bins in distribution
    this.binSize = options.binSize ?? 0; // Frequency width per bin in Hz
    this.binSizeBpm = options.binSizeBpm ?? null; // Frequency width per bin in BPM
    this.peakBin = null; // Index of dominant frequency bin
    this.peakFreq = null; // Frequency of peak in Hz
    this.peakBpm = null; // Peak in BPM
    this.minFreq = options.minFreq ?? 0.75; // Physiological passband lower bound (Hz)
    this.maxFreq = options.maxFreq ?? 3.0; // Physiological passband upper bound (Hz)
    this.sampleRate = options.sampleRate ?? 30; // Input signal sample rate (Hz)

    // Dynamic Y-axis magnitude auto-scaling
    this.smoothedMax = 1.0;

    // Canvas scaling & resizing
    this.resizeCanvas();
    window.addEventListener("resize", () => this.resizeCanvas());
  }

  /**
   * Resizes internal canvas dimensions for high-DPI displays without pixelation.
   */
  resizeCanvas() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    this.displayWidth = rect.width;
    this.displayHeight = rect.height;
    this.dpr = dpr;
    this.draw();
  }

  /**
   * Sets or updates the whole spectral distribution.
   * Accepts either an object (such as calculateBPM result) or a raw numeric array / Float32Array.
   *
   * @param {Object|Float32Array|number[]} data - Distribution data or BPM result.
   * @param {Object} [options] - Optional override parameters (binSize, peakBin, etc.).
   */
  setData(data, options = {}) {
    if (!data) return;

    if (Array.isArray(data) || data instanceof Float32Array || data instanceof Float64Array) {
      this.spectrum = data;
      this.binCount = data.length;
      if (options.binSize !== undefined) this.binSize = options.binSize;
      if (options.peakBin !== undefined) this.peakBin = options.peakBin;
      if (options.peakFreq !== undefined) this.peakFreq = options.peakFreq;
      if (options.peakBpm !== undefined) this.peakBpm = options.peakBpm;
      if (options.minFreq !== undefined) this.minFreq = options.minFreq;
      if (options.maxFreq !== undefined) this.maxFreq = options.maxFreq;
    } else if (typeof data === "object") {
      this.spectrum = data.spectrum || data.distribution || data.magnitudes || data.powers || null;
      this.binCount = data.binCount ?? (this.spectrum ? this.spectrum.length : 0);
      this.binSize = data.binSize ?? data.freqResolution ?? options.binSize ?? this.binSize;
      this.binSizeBpm = data.binSizeBpm ?? (this.binSize ? this.binSize * 60 : null);
      this.peakBin = data.peakBin ?? options.peakBin ?? null;
      this.peakFreq = data.frequencyHz ?? data.peakFreq ?? options.peakFreq ?? null;
      this.peakBpm = data.bpm ?? data.peakBpm ?? options.peakBpm ?? null;
      this.minFreq = data.minFreq ?? options.minFreq ?? this.minFreq;
      this.maxFreq = data.maxFreq ?? options.maxFreq ?? this.maxFreq;
      this.sampleRate = data.sampleRate ?? options.sampleRate ?? this.sampleRate;
    }

    // Auto-detect peak if not explicitly specified
    if (this.spectrum && this.spectrum.length > 0 && this.peakBin === null) {
      let maxVal = -Infinity;
      let maxIdx = 0;
      for (let i = 0; i < this.spectrum.length; i++) {
        if (this.spectrum[i] > maxVal) {
          maxVal = this.spectrum[i];
          maxIdx = i;
        }
      }
      this.peakBin = maxIdx;
      if (this.binSize > 0 && this.peakFreq === null) {
        this.peakFreq = Number((this.peakBin * this.binSize).toFixed(2));
        this.peakBpm = Math.round(this.peakFreq * 60);
      }
    }

    // Dynamic auto-scaling of magnitude axis
    if (this.spectrum && this.spectrum.length > 0) {
      let currentMax = 0;
      for (let i = 0; i < this.spectrum.length; i++) {
        const v = this.spectrum[i];
        if (v > currentMax) currentMax = v;
      }
      if (currentMax <= 0) currentMax = 1;

      if (!isFinite(this.smoothedMax) || this.smoothedMax <= 0) {
        this.smoothedMax = currentMax;
      } else {
        this.smoothedMax += (currentMax - this.smoothedMax) * 0.25;
      }
    }

    this.draw();
  }

  /**
   * Convenience alias to update the whole distribution with an explicit bin size and count.
   *
   * @param {Float32Array|number[]} distribution
   * @param {number} [binSize]
   * @param {number} [binCount]
   */
  setDistribution(distribution, binSize = this.binSize, binCount = null) {
    this.setData(distribution, {
      binSize,
      binCount: binCount ?? (distribution ? distribution.length : 0)
    });
  }

  /**
   * Clears current spectral data and resets visualization to idle state.
   */
  clear() {
    this.spectrum = null;
    this.binCount = 0;
    this.peakBin = null;
    this.peakFreq = null;
    this.peakBpm = null;
    this.draw();
  }

  /**
   * Formats a numeric value cleanly for numeric axis labels.
   * @param {number} val
   * @returns {string}
   */
  formatScaleValue(val) {
    if (isNaN(val) || Math.abs(val) < 1e-5) return "0";
    const abs = Math.abs(val);
    if (abs >= 1000) return (val / 1000).toFixed(1) + "k";
    if (abs >= 100) return val.toFixed(0);
    if (abs >= 10) return val.toFixed(1);
    return val.toFixed(2);
  }

  /**
   * Computes a clean, round step size for axis tick marks.
   * @param {number} range
   * @param {number} targetSteps
   * @returns {number}
   */
  getNiceStep(range, targetSteps = 6) {
    if (range <= 0) return 1;
    const roughStep = range / targetSteps;
    const magnitude = Math.pow(10, Math.floor(Math.log10(roughStep)));
    const normalized = roughStep / magnitude;
    let niceNorm;
    if (normalized < 1.5) niceNorm = 1;
    else if (normalized < 3) niceNorm = 2;
    else if (normalized < 7) niceNorm = 5;
    else niceNorm = 10;
    return niceNorm * magnitude;
  }

  /**
   * Renders the complete FFT distribution, scales, and bottom metadata bar.
   */
  draw() {
    const ctx = this.ctx;
    const dpr = this.dpr || window.devicePixelRatio || 1;
    const width = this.displayWidth || (this.canvas.width / dpr);
    const height = this.displayHeight || (this.canvas.height / dpr);

    if (width <= 0 || height <= 0) return;

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // 1. Clear chart background
    ctx.fillStyle = "#070a10";
    ctx.fillRect(0, 0, width, height);

    // 2. Calculate coordinate geometry
    const plotLeft = this.showScale ? this.scaleWidth : 10;
    const plotRight = width - 12;
    const plotWidth = Math.max(10, plotRight - plotLeft);
    const plotTop = 14;

    const bottomBarY = height - (this.showBottomBar ? this.bottomBarHeight : 0);
    const plotBottom = bottomBarY - (this.showXScale ? this.xScaleHeight : 4);
    const plotHeight = Math.max(10, plotBottom - plotTop);

    const numBins = this.spectrum ? this.spectrum.length : this.binCount;
    const maxFreqHz = (numBins > 0 && this.binSize > 0) ? (numBins - 1) * this.binSize : 0;

    // 3. Highlight physiological pulse passband (0.75 Hz to 3.0 Hz / 45 to 180 BPM)
    this.drawPassbandHighlight(ctx, plotLeft, plotTop, plotWidth, plotHeight, numBins);

    // 4. Draw horizontal & vertical gridlines
    this.drawGrid(ctx, plotLeft, plotTop, plotWidth, plotHeight, plotRight, plotBottom);

    // 5. Draw vertical numeric Y-axis scale (Magnitude)
    if (this.showScale) {
      this.drawYScale(ctx, plotLeft, plotTop, plotHeight, plotBottom);
    }

    // 6. Draw horizontal numeric X-axis scale (Frequency in Hz or Bins)
    if (this.showXScale) {
      this.drawXScale(ctx, plotLeft, plotRight, plotWidth, plotBottom, numBins, maxFreqHz);
    }

    // 7. Render distribution (spectrum)
    if (!this.spectrum || this.spectrum.length === 0) {
      this.drawIdleState(ctx, plotLeft, plotRight, plotTop, plotBottom, plotHeight);
    } else {
      this.drawDistribution(ctx, plotLeft, plotTop, plotWidth, plotHeight, plotBottom, numBins);
    }

    // 8. Draw bottom bar with bin size, bin count, and peak stats
    if (this.showBottomBar) {
      this.drawBottomBar(ctx, width, height, bottomBarY, maxFreqHz);
    }

    ctx.restore();
  }

  /**
   * Draws subtle background shading for the physiological heart rate frequency range.
   */
  drawPassbandHighlight(ctx, plotLeft, plotTop, plotWidth, plotHeight, numBins) {
    if (numBins <= 0 || !this.binSize || this.binSize <= 0) return;

    const minBin = Math.max(0, Math.floor(this.minFreq / this.binSize));
    const maxBin = Math.min(numBins - 1, Math.ceil(this.maxFreq / this.binSize));
    if (minBin >= maxBin) return;

    const x1 = plotLeft + (minBin / (numBins - 1)) * plotWidth;
    const x2 = plotLeft + (maxBin / (numBins - 1)) * plotWidth;
    const bandWidth = Math.max(1, x2 - x1);

    ctx.save();
    // Shaded passband fill
    ctx.fillStyle = this.bandHighlightColor;
    ctx.fillRect(x1, plotTop, bandWidth, plotHeight);

    // Subtle dashed boundary markers
    ctx.strokeStyle = "rgba(0, 210, 255, 0.22)";
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(x1, plotTop);
    ctx.lineTo(x1, plotTop + plotHeight);
    ctx.moveTo(x2, plotTop);
    ctx.lineTo(x2, plotTop + plotHeight);
    ctx.stroke();

    // Pulse band label at top edge
    ctx.setLineDash([]);
    ctx.font = '600 8.5px "SF Mono", "Roboto Mono", Consolas, monospace';
    ctx.fillStyle = "rgba(0, 210, 255, 0.55)";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText("HEART RATE PASSBAND (45–180 BPM)", (x1 + x2) / 2, plotTop + 2);
    ctx.restore();
  }

  /**
   * Draws background gridlines.
   */
  drawGrid(ctx, plotLeft, plotTop, plotWidth, plotHeight, plotRight, plotBottom) {
    ctx.save();
    ctx.strokeStyle = "rgba(32, 45, 74, 0.35)";
    ctx.lineWidth = 1;

    // Horizontal grid lines
    const numH = 5;
    for (let i = 0; i <= numH; i++) {
      const y = plotTop + (plotHeight / numH) * i;
      ctx.beginPath();
      ctx.moveTo(plotLeft, y);
      ctx.lineTo(plotRight, y);
      ctx.stroke();
    }

    // Vertical grid lines
    const numV = 8;
    for (let i = 0; i <= numV; i++) {
      const x = plotLeft + (plotWidth / numV) * i;
      ctx.beginPath();
      ctx.moveTo(x, plotTop);
      ctx.lineTo(x, plotBottom);
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * Draws the vertical Y-axis numeric scale along the left edge.
   */
  drawYScale(ctx, plotLeft, plotTop, plotHeight, plotBottom) {
    ctx.save();
    ctx.font = '600 10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Roboto Mono", monospace';
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";

    // Axis divider line
    ctx.strokeStyle = "rgba(45, 65, 100, 0.65)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(plotLeft, plotTop);
    ctx.lineTo(plotLeft, plotBottom);
    ctx.stroke();

    const numH = 5;
    const range = this.smoothedMax || 1;

    for (let i = 0; i <= numH; i++) {
      const y = plotTop + (plotHeight / numH) * i;
      const normalized = (numH - i) / numH;
      const val = normalized * range;
      const label = this.formatScaleValue(val);

      // Tick mark
      ctx.strokeStyle = "rgba(100, 140, 190, 0.5)";
      ctx.beginPath();
      ctx.moveTo(plotLeft - 4, y);
      ctx.lineTo(plotLeft, y);
      ctx.stroke();

      // Number text
      if (i === numH) {
        ctx.fillStyle = "#00d2ff"; // Baseline 0
      } else {
        ctx.fillStyle = "rgba(160, 190, 230, 0.8)";
      }
      ctx.fillText(label, plotLeft - 7, y);
    }
    ctx.restore();
  }

  /**
   * Draws the horizontal X-axis numeric frequency scale along the bottom edge of the plot.
   */
  drawXScale(ctx, plotLeft, plotRight, plotWidth, plotBottom, numBins, maxFreqHz) {
    ctx.save();
    ctx.font = '600 9.5px "SF Mono", "Roboto Mono", Consolas, monospace';
    ctx.textAlign = "center";
    ctx.textBaseline = "top";

    // Horizontal baseline axis line
    ctx.strokeStyle = "rgba(45, 65, 100, 0.65)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(plotLeft, plotBottom);
    ctx.lineTo(plotRight, plotBottom);
    ctx.stroke();

    if (numBins > 1 && this.binSize > 0 && maxFreqHz > 0) {
      // Frequency-based ticks (Hz)
      const targetTicks = Math.max(3, Math.min(10, Math.floor(plotWidth / 75)));
      const step = this.getNiceStep(maxFreqHz, targetTicks);

      for (let f = 0; f <= maxFreqHz + 1e-5; f += step) {
        const norm = f / maxFreqHz;
        if (norm > 1.0) break;
        const x = plotLeft + norm * plotWidth;

        // Tick mark
        ctx.strokeStyle = "rgba(100, 140, 190, 0.5)";
        ctx.beginPath();
        ctx.moveTo(x, plotBottom);
        ctx.lineTo(x, plotBottom + 4);
        ctx.stroke();

        // Label
        ctx.fillStyle = "rgba(160, 190, 230, 0.8)";
        const label = f < 10 ? f.toFixed(1) + " Hz" : f.toFixed(0) + " Hz";
        ctx.fillText(label, x, plotBottom + 6);
      }
    } else {
      // Bin-index based ticks
      const totalBins = Math.max(1, numBins || 512);
      const targetTicks = Math.max(3, Math.min(8, Math.floor(plotWidth / 80)));
      const step = this.getNiceStep(totalBins, targetTicks);

      for (let b = 0; b <= totalBins; b += step) {
        const norm = b / totalBins;
        if (norm > 1.0) break;
        const x = plotLeft + norm * plotWidth;

        ctx.strokeStyle = "rgba(100, 140, 190, 0.5)";
        ctx.beginPath();
        ctx.moveTo(x, plotBottom);
        ctx.lineTo(x, plotBottom + 4);
        ctx.stroke();

        ctx.fillStyle = "rgba(160, 190, 230, 0.8)";
        ctx.fillText(`${b}`, x, plotBottom + 6);
      }
    }
    ctx.restore();
  }

  /**
   * Draws idle baseline and prompt when no spectral data is active.
   */
  drawIdleState(ctx, plotLeft, plotRight, plotTop, plotBottom, plotHeight) {
    ctx.save();
    // Idle baseline
    ctx.strokeStyle = "rgba(0, 210, 255, 0.35)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(plotLeft, plotBottom);
    ctx.lineTo(plotRight, plotBottom);
    ctx.stroke();

    // Subtle helper text
    ctx.font = '500 12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.fillStyle = "rgba(139, 155, 180, 0.6)";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Awaiting spectral FFT distribution...", (plotLeft + plotRight) / 2, plotTop + plotHeight * 0.45);
    ctx.restore();
  }

  /**
   * Renders the whole spectral distribution quickly using high-performance Canvas 2D paths.
   */
  drawDistribution(ctx, plotLeft, plotTop, plotWidth, plotHeight, plotBottom, numBins) {
    const data = this.spectrum;
    const maxVal = this.smoothedMax || 1;
    const stepX = plotWidth / (numBins - 1 || 1);

    ctx.save();

    // 1. Render vertical spectral bars if in "bars" or "both" mode
    if (this.renderMode === "bars" || this.renderMode === "both") {
      const barWidth = Math.max(1, stepX - 0.5);
      for (let i = 0; i < numBins; i++) {
        const val = data[i];
        if (val <= 0) continue;

        const normY = Math.min(1, Math.max(0, val / maxVal));
        const barH = normY * plotHeight;
        const x = plotLeft + i * stepX - barWidth / 2;
        const y = plotBottom - barH;

        // Peak bin gets prominent accent highlight
        if (i === this.peakBin) {
          ctx.fillStyle = this.peakColor;
        } else {
          ctx.fillStyle = "rgba(0, 210, 255, 0.35)";
        }
        ctx.fillRect(Math.max(plotLeft, x), y, barWidth, barH);
      }
    }

    // 2. Render glowing area & contour line if in "curve" or "both" mode
    if (this.renderMode === "curve" || this.renderMode === "both") {
      // Area Fill
      ctx.beginPath();
      ctx.moveTo(plotLeft, plotBottom);
      for (let i = 0; i < numBins; i++) {
        const x = plotLeft + i * stepX;
        const normY = Math.min(1, Math.max(0, data[i] / maxVal));
        const y = plotBottom - normY * plotHeight;
        ctx.lineTo(x, y);
      }
      ctx.lineTo(plotLeft + (numBins - 1) * stepX, plotBottom);
      ctx.closePath();
      ctx.fillStyle = "rgba(0, 210, 255, 0.12)";
      ctx.fill();

      // Top Contour Glow Line
      ctx.strokeStyle = this.strokeColor;
      ctx.lineWidth = 2;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.shadowColor = this.glowColor;
      ctx.shadowBlur = 8;

      ctx.beginPath();
      for (let i = 0; i < numBins; i++) {
        const x = plotLeft + i * stepX;
        const normY = Math.min(1, Math.max(0, data[i] / maxVal));
        const y = plotBottom - normY * plotHeight;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    // 3. Highlight Dominant Peak Marker
    if (this.peakBin !== null && this.peakBin >= 0 && this.peakBin < numBins) {
      const peakX = plotLeft + this.peakBin * stepX;
      const peakNormY = Math.min(1, Math.max(0, data[this.peakBin] / maxVal));
      const peakY = plotBottom - peakNormY * plotHeight;

      ctx.shadowColor = this.peakColor;
      ctx.shadowBlur = 10;

      // Vertical dashed marker line through peak
      ctx.strokeStyle = this.peakColor;
      ctx.lineWidth = 1.25;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(peakX, plotBottom);
      ctx.lineTo(peakX, peakY);
      ctx.stroke();

      // Glowing peak point dot
      ctx.setLineDash([]);
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(peakX, peakY, 3.5, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = this.peakColor;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(peakX, peakY, 4.5, 0, Math.PI * 2);
      ctx.stroke();

      // Peak readout badge label
      const peakLabel = this.peakBpm
        ? `${this.peakFreq ? this.peakFreq.toFixed(2) + " Hz • " : ""}${this.peakBpm} BPM`
        : this.peakFreq ? `${this.peakFreq.toFixed(2)} Hz` : `Bin #${this.peakBin}`;

      ctx.font = '700 9.5px "SF Mono", "Roboto Mono", Consolas, monospace';
      const textWidth = ctx.measureText(peakLabel).width;
      const badgePadX = 6;
      const badgeH = 16;
      let badgeX = peakX - (textWidth + badgePadX * 2) / 2;
      badgeX = Math.max(plotLeft + 4, Math.min(plotLeft + plotWidth - (textWidth + badgePadX * 2) - 4, badgeX));
      // const badgeY = Math.max(plotTop + 2, peakY - badgeH - 6);
      const badgeY = plotBottom - badgeH - 3;

      // Pill badge container
      ctx.fillStyle = "rgba(10, 14, 23, 0.9)";
      ctx.strokeStyle = this.peakColor;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(badgeX, badgeY, textWidth + badgePadX * 2, badgeH, 4);
      ctx.fill();
      ctx.stroke();

      // Pill text
      ctx.fillStyle = "#ffffff";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(peakLabel, badgeX + (textWidth + badgePadX * 2) / 2, badgeY + badgeH / 2);
    }

    ctx.restore();
  }

  /**
   * Draws the dedicated bottom bar indicating the bin size, count, and spectral statistics.
   */
  drawBottomBar(ctx, width, height, bottomBarY, maxFreqHz) {
    ctx.save();

    // 1. Bottom bar background fill
    ctx.fillStyle = "#090d16";
    ctx.fillRect(0, bottomBarY, width, this.bottomBarHeight);

    // 2. Top separator border
    ctx.strokeStyle = "rgba(32, 45, 74, 0.85)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, bottomBarY);
    ctx.lineTo(width, bottomBarY);
    ctx.stroke();

    // 3. Assemble metadata items
    const binSizeStr = this.binSize > 0
      ? (this.binSize < 0.1 ? this.binSize.toFixed(4) : this.binSize.toFixed(2)) + " Hz"
      : "--";
    const binSizeBpmStr = (this.binSizeBpm || (this.binSize ? this.binSize * 60 : null))
      ? ` (${(this.binSizeBpm || this.binSize * 60).toFixed(2)} BPM)`
      : "";

    const binCountStr = `${this.binCount || (this.spectrum ? this.spectrum.length : 0)} BINS`;

    const peakStr = this.peakFreq
      ? `${this.peakFreq.toFixed(2)} Hz${this.peakBpm ? ` (${this.peakBpm} BPM)` : ""}`
      : "--";

    const rangeStr = maxFreqHz > 0 ? `0 – ${maxFreqHz.toFixed(1)} Hz` : "--";

    // 4. Render styled badges / chips inside bottom bar
    const centerY = bottomBarY + this.bottomBarHeight / 2;
    ctx.font = '600 10.5px "SF Mono", "Roboto Mono", Consolas, monospace';
    ctx.textBaseline = "middle";

    let currentX = 14;

    // Item 1: Bin Size
    currentX = this.drawBottomChip(ctx, currentX, centerY, "BIN SIZE", `${binSizeStr}${binSizeBpmStr}`, "#00d2ff");

    // Item 2: Count
    currentX = this.drawBottomChip(ctx, currentX, centerY, "COUNT", binCountStr, "#00e5a3");

    // Item 3: Peak (if room available)
    if (width > 560 && this.peakFreq !== null) {
      currentX = this.drawBottomChip(ctx, currentX, centerY, "PEAK", peakStr, "#ffb800");
    }

    // Item 4: Range (aligned right if sufficient width)
    if (width > 720 && maxFreqHz > 0) {
      const rightLabel = "RANGE";
      const rightVal = rangeStr;
      ctx.textAlign = "right";
      ctx.fillStyle = "#00d2ff";
      ctx.fillText(rightVal, width - 14, centerY);

      const valWidth = ctx.measureText(rightVal).width;
      ctx.fillStyle = "rgba(139, 155, 180, 0.75)";
      ctx.fillText(rightLabel + ": ", width - 14 - valWidth, centerY);
    }

    ctx.restore();
  }

  /**
   * Helper to draw a single formatted metadata badge chip in the bottom bar.
   */
  drawBottomChip(ctx, x, centerY, label, value, valColor) {
    ctx.textAlign = "left";
    ctx.fillStyle = "rgba(139, 155, 180, 0.75)";
    ctx.fillText(`${label}: `, x, centerY);

    const labelWidth = ctx.measureText(`${label}: `).width;
    ctx.fillStyle = valColor;
    ctx.fillText(value, x + labelWidth, centerY);

    const valWidth = ctx.measureText(value).width;
    const spacing = 18;

    // Subtle divider dot between items
    ctx.fillStyle = "rgba(45, 65, 100, 0.8)";
    ctx.beginPath();
    ctx.arc(x + labelWidth + valWidth + spacing / 2, centerY, 1.5, 0, Math.PI * 2);
    ctx.fill();

    return x + labelWidth + valWidth + spacing;
  }
}

export class HeartRateHistoryVisualizer {
  /**
   * Heart Rate Over Time Trend Visualizer.
   * Tracks and renders a continuous rolling history of measured BPM over time,
   * complete with resting zone highlights (60-100 BPM), dynamic Y-axis auto-scaling,
   * time scale, and live pulsing indicator on the latest measurement.
   *
   * @param {HTMLCanvasElement} canvas - Target HTML canvas element.
   * @param {Object} [options]
   * @param {number} [options.timeWindowSec=60] - Rolling time window duration in seconds.
   * @param {string} [options.strokeColor="#ff3b69"] - Trendline stroke color.
   * @param {string} [options.glowColor="rgba(255, 59, 105, 0.6)"] - Glow color for pulse trendline.
   * @param {string} [options.fillColor="rgba(255, 59, 105, 0.14)"] - Area fill color under curve.
   * @param {boolean} [options.showScale=true] - Whether to show the vertical BPM scale.
   * @param {number} [options.scaleWidth=48] - Pixel width reserved for BPM scale.
   * @param {boolean} [options.showTimeScale=true] - Whether to show horizontal time axis.
   * @param {number} [options.timeScaleHeight=22] - Pixel height reserved for time scale.
   */
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");

    this.timeWindowSec = options.timeWindowSec ?? 60;
    this.strokeColor = options.strokeColor ?? "#ff3b69";
    this.secondaryColor = options.secondaryColor ?? "#00d2ff";
    this.glowColor = options.glowColor ?? "rgba(255, 59, 105, 0.6)";
    this.fillColor = options.fillColor ?? "rgba(255, 59, 105, 0.14)";
    this.restingZoneColor = options.restingZoneColor ?? "rgba(0, 229, 163, 0.07)";
    this.showScale = options.showScale ?? true;
    this.scaleWidth = options.scaleWidth ?? 48;
    this.showTimeScale = options.showTimeScale ?? true;
    this.timeScaleHeight = options.timeScaleHeight ?? 22;

    // Rolling points: Array of { timestamp: number, bpm: number, confidence: string }
    this.dataPoints = [];

    // Smoothed Y-axis range
    this.smoothedMin = 50;
    this.smoothedMax = 110;

    this.resizeCanvas();
    window.addEventListener("resize", () => this.resizeCanvas());
  }

  resizeCanvas() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    this.displayWidth = rect.width;
    this.displayHeight = rect.height;
    this.dpr = dpr;
    this.draw();
  }

  /**
   * Records a new heart rate measurement
   * @param {number} bpm - Heart rate in beats per minute
   * @param {number} [timestampMs] - Milliseconds timestamp (defaults to performance.now())
   * @param {string} [confidence="normal"] - "high" | "moderate" | "low"
   */
  addPoint(bpm, timestampMs = performance.now(), confidence = "normal") {
    if (isNaN(bpm) || bpm <= 0) return;

    this.dataPoints.push({
      timestamp: timestampMs,
      bpm: Math.round(bpm),
      confidence
    });

    // Prune points older than the rolling window (with 5s buffer to avoid clipping left edge)
    const cutoff = timestampMs - (this.timeWindowSec + 5) * 1000;
    while (this.dataPoints.length > 0 && this.dataPoints[0].timestamp < cutoff) {
      this.dataPoints.shift();
    }
  }

  /**
   * Resets heart rate history
   */
  clear() {
    this.dataPoints = [];
    this.smoothedMin = 50;
    this.smoothedMax = 110;
    this.draw();
  }

  /**
   * Calculates descriptive statistics for the recorded history
   * @returns {{ min: number|string, max: number|string, avg: number|string, current: number|string, count: number }}
   */
  getStats() {
    if (this.dataPoints.length === 0) {
      return { min: "--", max: "--", avg: "--", current: "--", count: 0 };
    }

    let min = Infinity;
    let max = -Infinity;
    let sum = 0;

    for (let i = 0; i < this.dataPoints.length; i++) {
      const b = this.dataPoints[i].bpm;
      if (b < min) min = b;
      if (b > max) max = b;
      sum += b;
    }

    const avg = Math.round(sum / this.dataPoints.length);
    const current = this.dataPoints[this.dataPoints.length - 1].bpm;

    return { min, max, avg, current, count: this.dataPoints.length };
  }

  /**
   * Main render loop
   */
  draw() {
    const ctx = this.ctx;
    const dpr = this.dpr || window.devicePixelRatio || 1;
    const width = this.displayWidth || (this.canvas.width / dpr);
    const height = this.displayHeight || (this.canvas.height / dpr);

    if (width <= 0 || height <= 0) return;

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // 1. Clear chart background
    ctx.fillStyle = "#070a10";
    ctx.fillRect(0, 0, width, height);

    // 2. Geometry
    const plotLeft = this.showScale ? this.scaleWidth : 12;
    const plotRight = width - 14;
    const plotWidth = Math.max(10, plotRight - plotLeft);
    const plotTop = 14;
    const plotBottom = height - (this.showTimeScale ? this.timeScaleHeight : 4);
    const plotHeight = Math.max(10, plotBottom - plotTop);

    // 3. Dynamic auto-scaling of BPM axis
    if (this.dataPoints.length > 0) {
      let curMin = Infinity;
      let curMax = -Infinity;
      for (let i = 0; i < this.dataPoints.length; i++) {
        const b = this.dataPoints[i].bpm;
        if (b < curMin) curMin = b;
        if (b > curMax) curMax = b;
      }

      // Add generous margin and clamp to sensible boundaries
      let targetMin = Math.max(35, Math.floor((curMin - 8) / 10) * 10);
      let targetMax = Math.min(220, Math.ceil((curMax + 8) / 10) * 10);

      // Keep minimum span of 40 BPM to prevent hyper-sensitive jitter
      if (targetMax - targetMin < 40) {
        const mid = (targetMin + targetMax) / 2;
        targetMin = Math.max(35, Math.floor(mid - 20));
        targetMax = targetMin + 40;
      }

      this.smoothedMin += (targetMin - this.smoothedMin) * 0.15;
      this.smoothedMax += (targetMax - this.smoothedMax) * 0.15;
    } else {
      this.smoothedMin += (50 - this.smoothedMin) * 0.15;
      this.smoothedMax += (110 - this.smoothedMax) * 0.15;
    }

    const bpmRange = Math.max(20, this.smoothedMax - this.smoothedMin);

    // 4. Highlight normal resting heart rate range (60 to 100 BPM)
    this.drawRestingZone(ctx, plotLeft, plotRight, plotTop, plotBottom, plotHeight, bpmRange);

    // 5. Draw gridlines
    this.drawGrid(ctx, plotLeft, plotRight, plotTop, plotBottom, plotWidth, plotHeight, bpmRange);

    // 6. Draw vertical Y-axis scale (BPM)
    if (this.showScale) {
      this.drawYScale(ctx, plotLeft, plotTop, plotBottom, plotHeight, bpmRange);
    }

    // 7. Draw horizontal X-axis scale (Time)
    if (this.showTimeScale) {
      this.drawTimeScale(ctx, plotLeft, plotRight, plotWidth, plotBottom);
    }

    // 8. Render heart rate trendline
    if (this.dataPoints.length === 0) {
      this.drawIdleState(ctx, plotLeft, plotRight, plotTop, plotBottom, plotHeight);
    } else {
      this.drawTrendline(ctx, plotLeft, plotRight, plotTop, plotWidth, plotHeight, plotBottom, bpmRange);
    }

    ctx.restore();
  }

  /**
   * Highlights normal resting heart rate zone (60 - 100 BPM)
   */
  drawRestingZone(ctx, plotLeft, plotRight, plotTop, plotBottom, plotHeight, bpmRange) {
    const minBpm = this.smoothedMin;
    const maxBpm = this.smoothedMax;

    if (minBpm >= 100 || maxBpm <= 60) return;

    const norm60 = Math.max(0, Math.min(1, (60 - minBpm) / bpmRange));
    const norm100 = Math.max(0, Math.min(1, (100 - minBpm) / bpmRange));

    const y60 = plotBottom - norm60 * plotHeight;
    const y100 = plotBottom - norm100 * plotHeight;
    const zoneHeight = y60 - y100;

    if (zoneHeight <= 0) return;

    ctx.save();
    // // Shaded resting zone fill
    // ctx.fillStyle = this.restingZoneColor;
    // ctx.fillRect(plotLeft, y100, plotRight - plotLeft, zoneHeight);

    // // Subtle dashed boundaries for 60 and 100 BPM
    // ctx.strokeStyle = "rgba(0, 229, 163, 0.28)";
    // ctx.lineWidth = 1;
    // ctx.setLineDash([4, 4]);

    // ctx.beginPath();
    // ctx.moveTo(plotLeft, y100);
    // ctx.lineTo(plotRight, y100);
    // ctx.moveTo(plotLeft, y60);
    // ctx.lineTo(plotRight, y60);
    // ctx.stroke();

    // // Resting zone watermark label
    // ctx.setLineDash([]);
    // ctx.font = '600 8.5px "SF Mono", "Roboto Mono", Consolas, monospace';
    // ctx.fillStyle = "rgba(0, 229, 163, 0.45)";
    // ctx.textAlign = "right";
    // ctx.textBaseline = "top";
    // ctx.fillText("RESTING NORMAL (60–100 BPM)", plotRight - 8, y100 + 3);

    // ctx.restore();
  }

  /**
   * Background gridlines
   */
  drawGrid(ctx, plotLeft, plotRight, plotTop, plotBottom, plotWidth, plotHeight, bpmRange) {
    ctx.save();
    ctx.strokeStyle = "rgba(32, 45, 74, 0.35)";
    ctx.lineWidth = 1;

    // Horizontal grid lines: at multiples of 10 or 20 BPM
    const stepBpm = bpmRange > 70 ? 20 : 10;
    const firstBpm = Math.ceil(this.smoothedMin / stepBpm) * stepBpm;

    for (let b = firstBpm; b <= this.smoothedMax; b += stepBpm) {
      const normY = (b - this.smoothedMin) / bpmRange;
      if (normY < 0.05 || normY > 0.95) continue;
      const y = plotBottom - normY * plotHeight;

      ctx.beginPath();
      ctx.moveTo(plotLeft, y);
      ctx.lineTo(plotRight, y);
      ctx.stroke();
    }

    // Vertical time grid lines (4-5 divisions)
    const numV = 4;
    for (let i = 1; i <= numV; i++) {
      const x = plotLeft + (plotWidth / numV) * i;
      ctx.beginPath();
      ctx.moveTo(x, plotTop);
      ctx.lineTo(x, plotBottom);
      ctx.stroke();
    }

    ctx.restore();
  }

  /**
   * Left Y-axis numeric scale
   */
  drawYScale(ctx, plotLeft, plotTop, plotBottom, plotHeight, bpmRange) {
    ctx.save();
    ctx.font = '600 9.5px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Roboto Mono", monospace';
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";

    // Axis divider line
    ctx.strokeStyle = "rgba(45, 65, 100, 0.65)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(plotLeft, plotTop);
    ctx.lineTo(plotLeft, plotBottom);
    ctx.stroke();

    const stepBpm = bpmRange > 70 ? 20 : 10;
    const firstBpm = Math.ceil(this.smoothedMin / stepBpm) * stepBpm;

    for (let b = firstBpm; b <= this.smoothedMax; b += stepBpm) {
      const normY = (b - this.smoothedMin) / bpmRange;
      if (normY < 0.02 || normY > 0.98) continue;
      const y = plotBottom - normY * plotHeight;

      // Tick mark
      ctx.strokeStyle = "rgba(100, 140, 190, 0.5)";
      ctx.beginPath();
      ctx.moveTo(plotLeft - 4, y);
      ctx.lineTo(plotLeft, y);
      ctx.stroke();

      // Label
      if (b === 60 || b === 100) {
        ctx.fillStyle = "#00e5a3"; // Normal range markers
      } else {
        ctx.fillStyle = "rgba(160, 190, 230, 0.75)";
      }
      ctx.fillText(`${b}`, plotLeft - 7, y);
    }

    // Y-axis title
    ctx.save();
    ctx.font = '700 8.5px "SF Mono", "Roboto Mono", Consolas, monospace';
    ctx.fillStyle = "rgba(139, 155, 180, 0.55)";
    ctx.textAlign = "center";
    ctx.fillText("BPM", plotLeft - 24, plotTop + 4);
    ctx.restore();

    ctx.restore();
  }

  /**
   * Horizontal time scale along the bottom of the plot
   */
  drawTimeScale(ctx, plotLeft, plotRight, plotWidth, plotBottom) {
    ctx.save();
    ctx.font = '600 9px "SF Mono", "Roboto Mono", Consolas, monospace';
    ctx.textAlign = "center";
    ctx.textBaseline = "top";

    // Axis baseline line
    ctx.strokeStyle = "rgba(45, 65, 100, 0.65)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(plotLeft, plotBottom);
    ctx.lineTo(plotRight, plotBottom);
    ctx.stroke();

    const divisions = 4; // -60s, -45s, -30s, -15s, Now
    const stepSec = this.timeWindowSec / divisions;

    for (let i = 0; i <= divisions; i++) {
      const x = plotLeft + (plotWidth / divisions) * i;
      const secondsAgo = Math.round(this.timeWindowSec - i * stepSec);

      // Tick mark
      ctx.strokeStyle = "rgba(100, 140, 190, 0.5)";
      ctx.beginPath();
      ctx.moveTo(x, plotBottom);
      ctx.lineTo(x, plotBottom + 4);
      ctx.stroke();

      // Label
      ctx.fillStyle = "rgba(160, 190, 230, 0.75)";
      const label = secondsAgo === 0 ? "Now" : `-${secondsAgo}s`;
      ctx.fillText(label, x, plotBottom + 6);
    }

    ctx.restore();
  }

  /**
   * Idle prompt when no BPM data is active
   */
  drawIdleState(ctx, plotLeft, plotRight, plotTop, plotBottom, plotHeight) {
    ctx.save();
    // Idle baseline at 70 BPM
    const norm70 = Math.max(0, Math.min(1, (70 - this.smoothedMin) / (this.smoothedMax - this.smoothedMin)));
    const y70 = plotBottom - norm70 * plotHeight;

    ctx.strokeStyle = "rgba(255, 59, 105, 0.3)";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(plotLeft, y70);
    ctx.lineTo(plotRight, y70);
    ctx.stroke();

    // Helper message
    ctx.setLineDash([]);
    ctx.font = '500 12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.fillStyle = "rgba(139, 155, 180, 0.6)";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Awaiting heart rate measurements...", (plotLeft + plotRight) / 2, plotTop + plotHeight * 0.45);

    ctx.restore();
  }

  /**
   * Renders the continuous heart rate trendline with glow and area fill
   */
  drawTrendline(ctx, plotLeft, plotRight, plotTop, plotWidth, plotHeight, plotBottom, bpmRange) {
    const pts = this.dataPoints;
    const windowMs = this.timeWindowSec * 1000;
    const latestTime = pts[pts.length - 1].timestamp;
    const windowStart = latestTime - windowMs;
    const effectiveRight = plotRight ?? (plotLeft + plotWidth);

    // Map data points to screen coordinates
    const coords = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const normX = (p.timestamp - windowStart) / windowMs;
      // Clamp X position inside plot bounds
      const x = plotLeft + Math.max(0, Math.min(1, normX)) * plotWidth;

      const normY = (p.bpm - this.smoothedMin) / bpmRange;
      const y = plotBottom - Math.max(0, Math.min(1, normY)) * plotHeight;

      coords.push({ x, y, bpm: p.bpm, confidence: p.confidence, timestamp: p.timestamp });
    }

    if (coords.length === 0) return;

    ctx.save();

    // If only 1 data point, draw horizontal indicator
    if (coords.length === 1) {
      const pt = coords[0];
      ctx.strokeStyle = this.strokeColor;
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(plotLeft, pt.y);
      ctx.lineTo(effectiveRight, pt.y);
      ctx.stroke();

      this.drawLatestMarker(ctx, pt.x, pt.y, pt.bpm, plotLeft, effectiveRight, plotTop);
      ctx.restore();
      return;
    }

    // 1. Translucent Area Fill under the curve
    ctx.beginPath();
    ctx.moveTo(coords[0].x, plotBottom);
    ctx.lineTo(coords[0].x, coords[0].y);

    for (let i = 1; i < coords.length; i++) {
      const prev = coords[i - 1];
      const cur = coords[i];
      const midX = (prev.x + cur.x) / 2;
      ctx.bezierCurveTo(midX, prev.y, midX, cur.y, cur.x, cur.y);
    }

    ctx.lineTo(coords[coords.length - 1].x, plotBottom);
    ctx.closePath();
    ctx.fillStyle = this.fillColor;
    ctx.fill();

    // 2. Glowing Trendline Stroke
    ctx.strokeStyle = this.strokeColor;
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.shadowColor = this.glowColor;
    ctx.shadowBlur = 10;

    ctx.beginPath();
    ctx.moveTo(coords[0].x, coords[0].y);
    for (let i = 1; i < coords.length; i++) {
      const prev = coords[i - 1];
      const cur = coords[i];
      const midX = (prev.x + cur.x) / 2;
      ctx.bezierCurveTo(midX, prev.y, midX, cur.y, cur.x, cur.y);
    }
    ctx.stroke();

    // 3. Subtle dots on historical points
    ctx.shadowBlur = 0;
    for (let i = 0; i < coords.length - 1; i++) {
      const c = coords[i];
      ctx.fillStyle = "rgba(255, 255, 255, 0.55)";
      ctx.beginPath();
      ctx.arc(c.x, c.y, 2, 0, Math.PI * 2);
      ctx.fill();
    }

    // 4. Live Pulsing Beacon on the Latest Point
    const latest = coords[coords.length - 1];
    this.drawLatestMarker(ctx, latest.x, latest.y, latest.bpm, plotLeft, effectiveRight, plotTop);

    ctx.restore();
  }

  /**
   * Draws animated glowing beacon and floating BPM readout on the most recent point
   */
  drawLatestMarker(ctx, x, y, bpm, plotLeft, plotRight, plotTop) {
    const pulsePhase = (performance.now() % 1200) / 1200; // 0 to 1
    const pulseRadius = 5 + pulsePhase * 10;
    const pulseAlpha = Math.max(0, 0.7 - pulsePhase * 0.7);
    const rightBound = plotRight ?? (plotLeft + 400);

    // Expanding beacon circle
    ctx.save();
    ctx.strokeStyle = `rgba(255, 59, 105, ${pulseAlpha})`;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x, y, pulseRadius, 0, Math.PI * 2);
    ctx.stroke();

    // Solid center dot
    ctx.fillStyle = "#ffffff";
    ctx.shadowColor = this.strokeColor;
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = this.strokeColor;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.stroke();

    // Floating value pill tag
    const badgeText = `${bpm} BPM`;
    ctx.font = '700 9.5px "SF Mono", "Roboto Mono", Consolas, monospace';
    const textWidth = ctx.measureText(badgeText).width;
    const padX = 6;
    const badgeH = 17;
    const badgeW = textWidth + padX * 2;

    let badgeX = x - badgeW / 2;
    badgeX = Math.max(plotLeft + 4, Math.min(rightBound - badgeW - 4, badgeX));
    const badgeY = Math.max(plotTop + 2, y - badgeH - 8);

    // Pill background
    ctx.fillStyle = "rgba(10, 14, 23, 0.92)";
    ctx.strokeStyle = this.strokeColor;
    ctx.lineWidth = 1;
    ctx.shadowColor = this.glowColor;
    ctx.shadowBlur = 6;
    ctx.beginPath();
    ctx.roundRect(badgeX, badgeY, badgeW, badgeH, 4);
    ctx.fill();
    ctx.stroke();

    // Text
    ctx.shadowBlur = 0;
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(badgeText, badgeX + badgeW / 2, badgeY + badgeH / 2);

    ctx.restore();
  }
}
