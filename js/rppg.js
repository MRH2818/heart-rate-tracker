export class RPPGProcessor {
  /**
   * @param {Object} options 
   * @param {number} [options.windowDurationSec=8] - Rolling buffer length in seconds
   * @param {number} [options.updateIntervalSec=1.0] - FFT re-evaluation interval in seconds
   * @param {number} [options.minBpm=45] - Minimum physiological BPM cutoff
   * @param {number} [options.maxBpm=180] - Maximum physiological BPM cutoff
   */
  constructor(options = {}) {
    this.windowDurationSec = options.windowDurationSec ?? 8;
    this.updateIntervalSec = options.updateIntervalSec ?? 1.0;
    this.minBpm = options.minBpm ?? 45;
    this.maxBpm = options.maxBpm ?? 180;
    this.algorithm = options.algorithm ?? "pos"; // "pos" (Plane-Orthogonal-to-Skin) | "green" (Spatial Green averaging)

    // Converted frequency boundaries in Hz (45 BPM = 0.75 Hz, 180 BPM = 3.0 Hz)
    this.minFreq = this.minBpm / 60;
    this.maxFreq = this.maxBpm / 60;

    // Target uniform resampling rate
    this.sampleRate = 30; // 30 Hz

    // Rolling time-series buffers
    this.samples = []; // Array of { timestamp: number, rawGreen: number, r: number, g: number, b: number }
    this.rawSignal = []; // Most recent raw pulse values
    this.filteredSignal = []; // Most recent filtered waveform for visualization

    this.lastCalculationTime = 0;
    this.lastBpmResult = null;

    // Real-time streaming IIR filter state
    this.initFilterState();

    // Offscreen canvas for sampling ROI pixels
    this.sampleCanvas = document.createElement("canvas");
    //document.body.appendChild(this.sampleCanvas);
    this.sampleCtx = this.sampleCanvas.getContext("2d", { willReadFrequently: true });
  }

  /**
   * Update configuration parameters dynamically
   */
  setConfig({ windowDurationSec, updateIntervalSec, algorithm }) {
    if (windowDurationSec !== undefined) {
      this.windowDurationSec = Number(windowDurationSec);
    }
    if (updateIntervalSec !== undefined) {
      this.updateIntervalSec = Number(updateIntervalSec);
    }
    if (algorithm !== undefined && algorithm !== this.algorithm) {
      this.algorithm = algorithm;
      this.initFilterState();
      this.rawSignal = [];
      this.filteredSignal = [];
    }
  }

  /**
   * Extracts spatial average RGB from the forehead region in the current video frame.
   * Uses the Green channel for primary rPPG pulse detection.
   * 
   * @param {HTMLVideoElement} videoElement 
   * @param {Object} roiData - { bounds: {x, y, width, height}, polygon: [{x, y}] }
   * @param {number} timestampMs 
   * @returns {Object|null} Extracted RGB and green sample
   */
  processFrame(videoElement, roiData, timestampMs) {
    if (!roiData || !roiData.bounds || roiData.bounds.width <= 0 || roiData.bounds.height <= 0) {
      return null;
    }

    const { x, y, width, height } = roiData.bounds;

    // Resize offscreen canvas to ROI dimensions
    if (this.sampleCanvas.width !== width || this.sampleCanvas.height !== height) {
      this.sampleCanvas.width = width;
      this.sampleCanvas.height = height;
    }

    // Draw only the forehead ROI to the offscreen canvas
    this.sampleCtx.drawImage(videoElement, x, y, width, height, 0, 0, width, height);

    const imgData = this.sampleCtx.getImageData(0, 0, width, height);
    const data = imgData.data;
    const totalPixels = width * height;

    if (totalPixels === 0) return null;

    let sumR = 0, sumG = 0, sumB = 0;
    // Step by 2 pixels (stride = 8 bytes) for fast, low-overhead spatial averaging
    let count = 0;
    for (let i = 0; i < data.length; i += 4) {
      sumR += data[i];
      sumG += data[i + 1];
      sumB += data[i + 2];
      count++;
    }

    const avgR = sumR / count;
    const avgG = sumG / count;
    const avgB = sumB / count;

    // Push new measurement to the rolling sample buffer
    this.samples.push({
      timestamp: timestampMs,
      rawGreen: avgG,
      r: avgR,
      g: avgG,
      b: avgB
    });

    // Prune samples older than the rolling buffer window
    const windowMs = this.windowDurationSec * 1000;
    const cutoffTime = timestampMs - windowMs;
    while (this.samples.length > 0 && this.samples[0].timestamp < cutoffTime) {
      this.samples.shift();
    }

    // Update live streaming signals on every animation frame
    let rawVal;
    if (this.algorithm === "pos") {
      rawVal = this.stepRealtimePOS(avgR, avgG, avgB);
    } else {
      rawVal = avgG;
    }

    const filteredVal = this.stepRealtimeFilter(rawVal);
    this.rawSignal.push(rawVal);
    this.filteredSignal.push(filteredVal);

    const maxSignalSamples = Math.ceil(this.windowDurationSec * this.sampleRate);
    while (this.rawSignal.length > maxSignalSamples) {
      this.rawSignal.shift();
    }
    while (this.filteredSignal.length > maxSignalSamples) {
      this.filteredSignal.shift();
    }

    // Check if it's time to run the periodic FFT calculation
    let bpmOutput = null;
    if (timestampMs - this.lastCalculationTime >= this.updateIntervalSec * 1000) {
      bpmOutput = this.calculateBPM(timestampMs);
      this.lastCalculationTime = timestampMs;
    }

    return {
      avgR,
      avgG,
      avgB,
      rawPoint: rawVal,
      filteredPoint: filteredVal,
      bpmResult: bpmOutput || this.lastBpmResult,
      bufferProgress: Math.max(0, Math.round(this.windowDurationSec - this.getBufferDuration()))
    };
  }

  /**
   * Initializes or clears state variables for real-time streaming IIR bandpass filter
   */
  initFilterState() {
    this.filterState = {
      x_hp1: 0,
      x_hp2: 0,
      y_hp1: 0,
      y_hp2: 0,
      x_lp1: 0,
      x_lp2: 0,
      y_lp1: 0,
      y_lp2: 0,
      runningMean: null
    };
  }

  /**
   * Applies the causal cascaded biquad bandpass filter (0.75 Hz to 3.0 Hz) to a single sample in real time.
   * Direct Form I implementation with DC offset tracking to eliminate startup transients.
   * 
   * @param {number} rawVal - Instantaneous spatial average green channel intensity.
   * @returns {number} Filtered pulse amplitude point.
   */
  stepRealtimeFilter(rawVal) {
    if (isNaN(rawVal)) return 0;

    const s = this.filterState;

    // 1. DC offset tracking (slow exponential moving average to prevent step-response jump)
    if (s.runningMean === null) {
      s.runningMean = rawVal;
    } else {
      s.runningMean += 0.02 * (rawVal - s.runningMean);
    }

    const zeroMean = rawVal - s.runningMean;

    // 2. Highpass Biquad section (~0.75 Hz)
    const b0_hp = 0.894, b1_hp = -1.788, b2_hp = 0.894;
    const a1_hp = -1.776, a2_hp = 0.799;

    const hpOut = b0_hp * zeroMean + b1_hp * s.x_hp1 + b2_hp * s.x_hp2
      - a1_hp * s.y_hp1 - a2_hp * s.y_hp2;

    s.x_hp2 = s.x_hp1;
    s.x_hp1 = zeroMean;
    s.y_hp2 = s.y_hp1;
    s.y_hp1 = hpOut;

    // 3. Lowpass Biquad section (~3.0 Hz)
    const b0_lp = 0.067, b1_lp = 0.134, b2_lp = 0.067;
    const a1_lp = -1.143, a2_lp = 0.413;

    const bpOut = b0_lp * hpOut + b1_lp * s.x_lp1 + b2_lp * s.x_lp2
      - a1_lp * s.y_lp1 - a2_lp * s.y_lp2;

    s.x_lp2 = s.x_lp1;
    s.x_lp1 = hpOut;
    s.y_lp2 = s.y_lp1;
    s.y_lp1 = bpOut;

    return bpOut;
  }

  /**
   * Returns current buffer duration in seconds
   */
  getBufferDuration() {
    if (this.samples.length < 2) return 0;
    return (this.samples[this.samples.length - 1].timestamp - this.samples[0].timestamp) / 1000;
  }

  /**
   * Resets all internal buffers
   */
  reset() {
    this.samples = [];
    this.rawSignal = [];
    this.filteredSignal = [];
    this.lastCalculationTime = 0;
    this.lastBpmResult = null;
    this.initFilterState();
  }

  /**
   * Computes the instantaneous POS pulse point for real-time streaming visualization.
   * Uses recent sliding window history (up to ~1.6s) to project the current frame's
   * RGB values onto the skin-orthogonal plane.
   * 
   * @param {number} avgR - Current spatial average Red intensity
   * @param {number} avgG - Current spatial average Green intensity
   * @param {number} avgB - Current spatial average Blue intensity
   * @returns {number} Instantaneous skin-orthogonal pulse amplitude
   */
  stepRealtimePOS(avgR, avgG, avgB) {
    const N = this.samples.length;
    const l = Math.min(48, N);
    if (l < 10) return 0;

    const startIdx = N - l;
    let sumR = 0, sumG = 0, sumB = 0;
    for (let i = startIdx; i < N; i++) {
      sumR += this.samples[i].r;
      sumG += this.samples[i].g;
      sumB += this.samples[i].b;
    }
    const meanR = sumR / l || 1;
    const meanG = sumG / l || 1;
    const meanB = sumB / l || 1;

    let sumS1 = 0, sumS2 = 0;
    const s1Arr = new Float32Array(l);
    const s2Arr = new Float32Array(l);
    for (let i = 0; i < l; i++) {
      const s = this.samples[startIdx + i];
      const rn = s.r / meanR;
      const gn = s.g / meanG;
      const bn = s.b / meanB;
      s1Arr[i] = gn - bn;
      s2Arr[i] = gn + bn - 2 * rn;
      sumS1 += s1Arr[i];
      sumS2 += s2Arr[i];
    }
    const meanS1 = sumS1 / l;
    const meanS2 = sumS2 / l;

    let varS1 = 0, varS2 = 0;
    for (let i = 0; i < l; i++) {
      const d1 = s1Arr[i] - meanS1;
      const d2 = s2Arr[i] - meanS2;
      varS1 += d1 * d1;
      varS2 += d2 * d2;
    }
    const stdS1 = Math.sqrt(varS1 / l);
    const stdS2 = Math.sqrt(varS2 / l);

    const alpha = stdS2 > 1e-6 ? (stdS1 / stdS2) : 0;

    const curRn = avgR / meanR;
    const curGn = avgG / meanG;
    const curBn = avgB / meanB;
    const curS1 = curGn - curBn;
    const curS2 = curGn + curBn - 2 * curRn;

    const rawPos = (curS1 + alpha * curS2) - (meanS1 + alpha * meanS2);
    return rawPos;
  }

  /**
   * =========================================================================
   * POS (Plane-Orthogonal-to-Skin) rPPG Algorithm
   * Reference: Wang et al., "Algorithmic Principles of Remote PPG", IEEE TBME 2017
   * =========================================================================
   * Extracts motion-robust and illumination-invariant blood volume pulse (BVP)
   * signals by projecting normalized RGB signals onto the skin-orthogonal plane
   * and reconstructing the continuous pulse wave via sliding-window overlap-add (OLA).
   * 
   * @param {Array<Object>|Object} input - Array of {r, g, b} or {r: Float32Array, g: Float32Array, b: Float32Array}
   * @param {number} [targetFs] - Sampling frequency in Hz (defaults to this.sampleRate, e.g. 30 Hz)
   * @returns {Float32Array} Continuous extracted pulse signal H of length N
   */
  computePOSSignal(input, targetFs = this.sampleRate) {
    const fs = targetFs || 30;

    // 1. Extract R, G, B channels as Float32Array
    let R, G, B, N;
    if (input && (input.r instanceof Float32Array || Array.isArray(input.r))) {
      R = input.r;
      G = input.g;
      B = input.b;
      N = R.length;
    } else if (Array.isArray(input)) {
      N = input.length;
      if (N === 0) return new Float32Array(0);
      R = new Float32Array(N);
      G = new Float32Array(N);
      B = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        R[i] = input[i].r;
        G[i] = input[i].g;
        B[i] = input[i].b;
      }
    } else {
      return new Float32Array(0);
    }

    if (N < 10) return new Float32Array(N);

    // 2. Determine sub-window length l (Wang et al.: l = round(1.6 * fs))
    // Covers at least one full heartbeat cycle at >= 40 BPM (~1.6 seconds)
    const l = Math.min(N, Math.max(10, Math.round(1.6 * fs)));

    // 3. Sliding sub-window overlap-add accumulation buffers
    const H = new Float32Array(N);
    const W = new Float32Array(N); // Overlap counter / weight for boundary normalization
    const numWindows = N - l + 1;

    // Allocate temporary sub-window arrays once to eliminate GC overhead
    const Rn = new Float32Array(l);
    const Gn = new Float32Array(l);
    const Bn = new Float32Array(l);
    const S1 = new Float32Array(l);
    const S2 = new Float32Array(l);
    const h = new Float32Array(l);

    for (let t = 0; t < numWindows; t++) {
      // Step A: Calculate temporal mean of R, G, B over sub-window [t, t + l - 1]
      let meanR = 0, meanG = 0, meanB = 0;
      for (let i = 0; i < l; i++) {
        meanR += R[t + i];
        meanG += G[t + i];
        meanB += B[t + i];
      }
      meanR /= l;
      meanG /= l;
      meanB /= l;

      const denomR = meanR !== 0 ? meanR : 1;
      const denomG = meanG !== 0 ? meanG : 1;
      const denomB = meanB !== 0 ? meanB : 1;

      // Step B: Normalize color signals by temporal mean
      for (let i = 0; i < l; i++) {
        Rn[i] = R[t + i] / denomR;
        Gn[i] = G[t + i] / denomG;
        Bn[i] = B[t + i] / denomB;
      }

      // Step C: Project onto two orthogonal axes S1 and S2
      // S1 = Gn - Bn
      // S2 = Gn + Bn - 2*Rn
      let meanS1 = 0, meanS2 = 0;
      for (let i = 0; i < l; i++) {
        S1[i] = Gn[i] - Bn[i];
        S2[i] = Gn[i] + Bn[i] - 2 * Rn[i];
        meanS1 += S1[i];
        meanS2 += S2[i];
      }
      meanS1 /= l;
      meanS2 /= l;

      // Step D: Calculate standard deviations of S1 and S2
      let varS1 = 0, varS2 = 0;
      for (let i = 0; i < l; i++) {
        const d1 = S1[i] - meanS1;
        const d2 = S2[i] - meanS2;
        varS1 += d1 * d1;
        varS2 += d2 * d2;
      }
      const stdS1 = Math.sqrt(varS1 / l);
      const stdS2 = Math.sqrt(varS2 / l);

      // Step E: Adaptive tuning parameter alpha = std(S1) / std(S2)
      const alpha = stdS2 > 1e-6 ? (stdS1 / stdS2) : 0;

      // Step F: Compute sub-window pulse signal h = S1 + alpha * S2
      let meanH = 0;
      for (let i = 0; i < l; i++) {
        h[i] = S1[i] + alpha * S2[i];
        meanH += h[i];
      }
      meanH /= l;

      // Step G: Demean sub-window signal and accumulate via Overlap-Add (OLA)
      for (let i = 0; i < l; i++) {
        H[t + i] += (h[i] - meanH);
        W[t + i] += 1;
      }
    }

    // 4. Normalize by overlap weight to prevent boundary tapering
    let globalMean = 0;
    for (let i = 0; i < N; i++) {
      if (W[i] > 0) {
        H[i] /= W[i];
      }
      globalMean += H[i];
    }
    globalMean /= N;

    // 5. Final zero-mean centering
    for (let i = 0; i < N; i++) {
      H[i] -= globalMean;
    }

    return H;
  }

  /**
   * Resamples unevenly-spaced webcam samples to uniform time intervals at targetFs (30 Hz).
   * Interpolates R, G, B, and rawGreen channels to provide synchronized inputs for rPPG algorithms.
   */
  resampleSignal(samples, targetFs) {
    if (samples.length < 2) {
      return {
        numPoints: 0,
        values: new Float32Array(0),
        r: new Float32Array(0),
        g: new Float32Array(0),
        b: new Float32Array(0)
      };
    }

    const startTime = samples[0].timestamp;
    const endTime = samples[samples.length - 1].timestamp;
    const totalDurationSec = (endTime - startTime) / 1000;
    const numPoints = Math.floor(totalDurationSec * targetFs);

    if (numPoints <= 1) {
      return {
        numPoints: 0,
        values: new Float32Array(0),
        r: new Float32Array(0),
        g: new Float32Array(0),
        b: new Float32Array(0)
      };
    }

    const resampledR = new Float32Array(numPoints);
    const resampledG = new Float32Array(numPoints);
    const resampledB = new Float32Array(numPoints);
    const dt = 1000 / targetFs;

    let sampleIdx = 0;
    for (let i = 0; i < numPoints; i++) {
      const t = startTime + i * dt;

      // Advance to the bounding timestamps
      while (sampleIdx < samples.length - 2 && samples[sampleIdx + 1].timestamp < t) {
        sampleIdx++;
      }

      const s0 = samples[sampleIdx];
      const s1 = samples[sampleIdx + 1];
      const t0 = s0.timestamp;
      const t1 = s1.timestamp;

      // Linear interpolation
      const fraction = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
      resampledR[i] = s0.r + fraction * (s1.r - s0.r);
      resampledG[i] = s0.g + fraction * (s1.g - s0.g);
      resampledB[i] = s0.b + fraction * (s1.b - s0.b);
    }

    return {
      numPoints,
      r: resampledR,
      g: resampledG,
      b: resampledB,
      values: resampledG // backward compatibility with Green channel
    };
  }

  /**
   * 2nd-order Butterworth IIR bandpass filter (0.75 Hz to 3.0 Hz at Fs = 30 Hz).
   * Coefficients computed using standard bilinear transform for:
   *  f_low = 0.75 Hz, f_high = 3.0 Hz, Fs = 30 Hz
   */
  applyBandpassFilter(signal) {
    const N = signal.length;
    if (N < 5) return signal;

    // 1. Subtract mean (DC removal)
    let mean = 0;
    for (let i = 0; i < N; i++) mean += signal[i];
    mean /= N;

    const zeroMean = new Float32Array(N);
    for (let i = 0; i < N; i++) zeroMean[i] = signal[i] - mean;

    // Direct Form II / Cascaded Biquad coefficients for [0.75 Hz, 3.0 Hz] at 30 Hz:
    // Section 1: Highpass ~0.75 Hz
    // Section 2: Lowpass ~3.0 Hz
    const b0_hp = 0.894, b1_hp = -1.788, b2_hp = 0.894;
    const a1_hp = -1.776, a2_hp = 0.799;

    const b0_lp = 0.067, b1_lp = 0.134, b2_lp = 0.067;
    const a1_lp = -1.143, a2_lp = 0.413;

    // Forward pass Highpass
    const hpOut = new Float32Array(N);
    for (let i = 2; i < N; i++) {
      hpOut[i] = b0_hp * zeroMean[i] + b1_hp * zeroMean[i - 1] + b2_hp * zeroMean[i - 2]
        - a1_hp * hpOut[i - 1] - a2_hp * hpOut[i - 2];
    }

    // Forward pass Lowpass
    const bpOut = new Float32Array(N);
    for (let i = 2; i < N; i++) {
      bpOut[i] = b0_lp * hpOut[i] + b1_lp * hpOut[i - 1] + b2_lp * hpOut[i - 2]
        - a1_lp * bpOut[i - 1] - a2_lp * bpOut[i - 2];
    }

    return bpOut;
  }

  /**
   * Fast Fourier Transform (Cooley-Tukey Radix-2 in-place decimation-in-time)
   * @param {Float32Array} real
   * @param {Float32Array} imag
   */
  fft(real, imag) {
    const n = real.length;
    // Bit-reversal permutation
    let j = 0;
    for (let i = 0; i < n - 1; i++) {
      if (i < j) {
        let tempR = real[i]; real[i] = real[j]; real[j] = tempR;
        let tempI = imag[i]; imag[i] = imag[j]; imag[j] = tempI;
      }
      let k = n >> 1;
      while (k <= j) {
        j -= k;
        k >>= 1;
      }
      j += k;
    }

    // Butterfly computations
    for (let len = 2; len <= n; len <<= 1) {
      const halfLen = len >> 1;
      const angle = (-2 * Math.PI) / len;
      const wStepR = Math.cos(angle);
      const wStepI = Math.sin(angle);

      for (let i = 0; i < n; i += len) {
        let wr = 1.0;
        let wi = 0.0;
        for (let k = 0; k < halfLen; k++) {
          const uR = real[i + k];
          const uI = imag[i + k];
          const vR = real[i + k + halfLen] * wr - imag[i + k + halfLen] * wi;
          const vI = real[i + k + halfLen] * wi + imag[i + k + halfLen] * wr;

          real[i + k] = uR + vR;
          imag[i + k] = uI + vI;
          real[i + k + halfLen] = uR - vR;
          imag[i + k + halfLen] = uI - vI;

          const nextWr = wr * wStepR - wi * wStepI;
          wi = wr * wStepI + wi * wStepR;
          wr = nextWr;
        }
      }
    }
  }

  /**
   * Performs spectral analysis and peak detection on the current rolling buffer.
   * @param {number} timestampMs 
   * @returns {Object|null} BPM analysis result
   */
  calculateBPM(timestampMs) {
    const bufferDuration = this.getBufferDuration();
    // Ensure we have at least 60% of the target window before reporting BPM
    if (bufferDuration < this.windowDurationSec * 0.6 || this.samples.length < 30) {
      return null;
    }

    // 1. Resample to 30 Hz
    const resampled = this.resampleSignal(this.samples, this.sampleRate);
    if (!resampled || resampled.numPoints < 30) return null;

    // 2. Extract pulse signal: Plane-Orthogonal-to-Skin (POS) or Green channel
    let pulseSignal;
    if (this.algorithm === "pos") {
      pulseSignal = this.computePOSSignal(resampled, this.sampleRate);
    } else {
      pulseSignal = resampled.values;
    }

    // 3. Bandpass filter the pulse wave
    const filtered = this.applyBandpassFilter(pulseSignal);

    const N = filtered.length;
    // 3. Zero-pad to next power of 2 (at least 1024 for fine frequency resolution)
    const fftSize = Math.max(1024, 1 << Math.ceil(Math.log2(N)));
    const real = new Float32Array(fftSize);
    const imag = new Float32Array(fftSize);

    // Apply Hamming window to prevent spectral leakage
    const denom = N > 1 ? N - 1 : 1;
    for (let i = 0; i < N; i++) {
      const hamming = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / denom);
      real[i] = filtered[i] * hamming;
    }

    // 4. Compute FFT
    this.fft(real, imag);

    // 5. Scan physiological frequency band (0.75 Hz to 3.0 Hz / 45 to 180 BPM)
    const freqResolution = this.sampleRate / fftSize; // ~0.0293 Hz per bin (~1.76 BPM)
    const minBin = Math.max(1, Math.floor(this.minFreq / freqResolution));
    const maxBin = Math.min(Math.floor(fftSize / 2), Math.ceil(this.maxFreq / freqResolution));

    let maxPower = -1;
    let peakBin = minBin;
    let totalBandPower = 0;

    for (let bin = minBin; bin <= maxBin; bin++) {
      const power = real[bin] * real[bin] + imag[bin] * imag[bin];
      totalBandPower += power;
      if (power > maxPower) {
        maxPower = power;
        peakBin = bin;
      }
    }

    // Compute dominant frequency and BPM
    const peakFreq = peakBin * freqResolution;
    const bpm = Math.round(peakFreq * 60);
    const peakPhaseCosSec = Math.atan2(imag[peakBin], real[peakBin]) / (2 * Math.PI);
    const totalCycles = (this.windowDurationSec) * peakFreq + peakPhaseCosSec;
    const nextBeatTimestamp = timestampMs + (1000 * (1 + Math.floor(totalCycles) - totalCycles) / peakFreq);

    // 6. Signal-to-Noise Ratio (SNR) in dB
    // Signal power = power within ±1 bin of the peak
    let peakPowerWindow = 0;
    for (let b = Math.max(minBin, peakBin - 1); b <= Math.min(maxBin, peakBin + 1); b++) {
      peakPowerWindow += real[b] * real[b] + imag[b] * imag[b];
    }
    const noisePower = Math.max(1e-6, totalBandPower - peakPowerWindow);
    const snrDb = 10 * Math.log10(peakPowerWindow / noisePower);

    // Classification confidence
    let confidence = "low";
    if (snrDb > 4.5 && bufferDuration >= this.windowDurationSec * 0.9) {
      confidence = "high";
    } else if (snrDb > 2.0) {
      confidence = "moderate";
    }

    // 7. Extract the whole magnitude distribution (positive frequencies up to Nyquist Fs/2)
    const halfSize = Math.floor(fftSize / 2);
    const spectrum = new Float32Array(halfSize);
    for (let bin = 0; bin < halfSize; bin++) {
      spectrum[bin] = Math.sqrt(real[bin] * real[bin] + imag[bin] * imag[bin]);
    }

    this.lastBpmResult = {
      bpm,
      frequencyHz: Number(peakFreq.toFixed(2)),
      snrDb: Number(snrDb.toFixed(1)),
      confidence,
      algorithm: this.algorithm,
      timestamp: timestampMs,
      // Full FFT distribution & spectral metadata
      spectrum,
      binSize: freqResolution,
      binSizeBpm: freqResolution * 60,
      binCount: halfSize,
      fftSize,
      sampleRate: this.sampleRate,
      peakBin,
      peakFreq,
      peakPhaseCosSec,
      nextBeatTimestamp,
      minFreq: this.minFreq,
      maxFreq: this.maxFreq,
      minBin,
      maxBin
    };

    return this.lastBpmResult;
  }
}
