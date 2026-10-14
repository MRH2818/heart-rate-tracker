# Live Heart Rate Tracker (Browser-Native rPPG)

A real-time, zero-backend, browser-native optical heart rate monitor that measures pulse rates using remote photoplethysmography (rPPG) and MediaPipe FaceLandmarker.

---

- **Forehead ROI Overlay**: Visual glowing polygon overlay confirming face alignment in real time.
- **Optical Pulse Extraction (Green & POS)**:
  - **Plane-Orthogonal-to-Skin (POS)**: Algorithm from Wang et al. (IEEE TBME 2017) projecting normalized temporal RGB signals onto the skin-orthogonal plane with sliding-window overlap-add (OLA), eliminating specular reflection and motion artifacts.
  - **Green Channel Spatial Averaging**: Simple single-channel optical pulse detection.
  - Switchable on the fly via the Algorithm Mode selector.
- **Digital Signal Processing**:
  - Linear resampling of RGB channels to a uniform 30 Hz time series.
  - Bandpass filter (0.75 Hz - 3.0 Hz / 45 - 180 BPM).
  - FFT with Hanning window.
- **Heart Rate Over Time (BPM Trend)**: Rolling 60s historical chart featuring continuous trend tracking, normal resting zone highlights (60-100 BPM), auto-scaling, dynamic Min/Avg/Max/Current statistics, and an animated pulsing beacon on the latest reading.
- **Heart Swell Pulse Animation**: Dynamic heart icon animation synchronized to the measured heart rate.
- **Oscilloscope Waveforms**: 60 FPS scrolling canvas charts rendering both the raw and filtered pulse waves, alongside the full FFT frequency distribution spectrum.
- **Configurable Parameters**: Adjustable buffer window (default: 8s), update interval (default: 1.0s), and algorithm mode (POS vs Green).

---

## File Structure

```
heart_rate_tracker/
├── index.html       # Dashboard layout, video view, oscilloscope charts, controls
├── styles.css       # Dark medical-monitor styling
├── README.md        # Quickstart and usage guide
└── js/
    ├── app.js          # Controller orchestrating video loop, UI, and module data flow
    ├── face-tracker.js # MediaPipe FaceLandmarker wrapper and forehead ROI calculation
    ├── heart-swell.js  # BPM-synchronized heart icon pulsation animation
    ├── rppg.js         # POS and Green extraction, filtering, and FFT
    └── visualizer.js   # Real-time oscilloscope pulse waveforms and FFT spectrum visualizers
```

---

## Required for Best Measurement Accuracy

1. **Even Lighting**: Sit facing a steady, well-lit light source (such as natural window light or a desk lamp). Avoid strong backlighting.
2. **Keep Head Steady**: Avoid talking or nodding during the initial 8-second calibration.
3. **Forehead Visibility**: Ensure hair or hats do not obstruct the upper forehead region highlighted by the green polygon.
