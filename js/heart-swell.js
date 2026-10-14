/**
 * heart-swell.js
 * 
 * Provides dynamic, BPM-synchronized heart pulsating animations for the
 * Live Heart Rate Tracker. Ensures that every beat animation is allowed to
 * completely finish before the next animation begins, eliminating visual
 * stutter, mid-beat interruptions, and sudden restarts.
 */

export class HeartSwell {
  /**
   * Initializes the heart swelling controller.
   * 
   * @param {string|HTMLElement} [target=".pulse-icon"] - CSS selector or DOM element representing the heart icon.
   */
  constructor(target = ".pulse-icon") {
    this.element = typeof target === "string" ? document.querySelector(target) : target;
    this.bpm = null;
    this.isBeating = false;
    this.isAnimating = false;
    this.scheduledRafId = null;
    this.pendingNextBeat = null;
    this.lastProcessedTimestamp = null;
    this.activeDurationSec = 1.0;

    this.boundOnAnimationEnd = (e) => this._onAnimationEnd(e);

    if (this.element) {
      this.element.addEventListener("animationend", this.boundOnAnimationEnd);
    } else {
      console.warn(`[HeartSwell] Target element "${target}" not found.`);
    }
  }

  /**
   * Schedules or updates the heart beating animation to synchronize with a target beat
   * timestamp and continue pulsating at the specified BPM.
   * 
   * If an animation is currently in progress, it is permitted to completely finish
   * before the new beat timing or updated BPM is triggered.
   * 
   * @param {number} nextBeatTimestamp - DOMHighResTimeStamp of the next expected systolic peak.
   * @param {number} bpm - Heart rate in beats per minute (e.g. 45 - 180).
   * @param {number} [currentTimestamp] - Optional current DOMHighResTimeStamp (defaults to performance.now()).
   */
  nextBeatUpdate(nextBeatTimestamp, bpm, currentTimestamp = performance.now()) {
    if (!this.element || !bpm || bpm <= 0) return;

    this.bpm = Math.round(bpm);
    this.isBeating = true;

    // Avoid redundant re-queuing of the exact same calculation timestamp
    if (this.lastProcessedTimestamp === nextBeatTimestamp && this.pendingNextBeat) {
      this.pendingNextBeat.bpm = this.bpm;
      return;
    }
    this.lastProcessedTimestamp = nextBeatTimestamp;

    const targetTime = typeof nextBeatTimestamp === "number" && !isNaN(nextBeatTimestamp)
      ? nextBeatTimestamp
      : currentTimestamp;

    // Queue the next beat
    this.pendingNextBeat = { nextBeatTimestamp: targetTime, bpm: this.bpm };

    // RULE: If an animation is currently running, allow it to completely finish!
    // _onAnimationEnd will pick up this.pendingNextBeat as soon as the current cycle completes.
    if (this.isAnimating) {
      return;
    }

    // If no animation is currently running, schedule or trigger the beat
    this._scheduleOrTriggerNextBeat(currentTimestamp || performance.now());
  }

  /**
   * Starts continuous heart pulsation immediately at a specified BPM.
   * 
   * @param {number} [bpm=72] - Beats per minute to start beating at.
   */
  start(bpm = 72) {
    const now = performance.now();
    this.nextBeatUpdate(now, bpm, now);
  }

  /**
   * Stops the heart swell animation.
   * If an animation is currently playing, it finishes gracefully and does not repeat.
   */
  stop() {
    if (this.scheduledRafId) {
      cancelAnimationFrame(this.scheduledRafId);
      this.scheduledRafId = null;
    }

    this.isBeating = false;
    this.pendingNextBeat = null;
    this.lastProcessedTimestamp = null;
    this.bpm = null;

    // If not animating, clear classes immediately
    if (!this.isAnimating && this.element) {
      this.element.classList.remove("beating");
      this.element.style.removeProperty("--beat-duration");
      this.element.style.removeProperty("--beat-delay");
    }
  }

  /**
   * Triggers a single manual heart swell contraction.
   * If an animation is currently active, waits for it to complete first.
   * 
   * @param {number} [durationMs=300] - Duration of the single swell in milliseconds.
   */
  swell(durationMs = 300) {
    if (!this.element) return;

    const periodSec = durationMs / 1000;

    if (this.isAnimating) {
      // Queue a single beat at next opportunity
      this.pendingNextBeat = { nextBeatTimestamp: performance.now(), bpm: Math.round(60 / periodSec), once: true };
      return;
    }

    this._startSingleBeatAnimation(periodSec);
  }

  /**
   * Disposes of event listeners and cancels background tasks.
   */
  destroy() {
    this.stop();
    if (this.element && this.boundOnAnimationEnd) {
      this.element.removeEventListener("animationend", this.boundOnAnimationEnd);
    }
  }

  /**
   * Invoked automatically by the browser when the CSS keyframe animation completes.
   * Guarantees that the previous animation has 100% finished before triggering the next.
   * 
   * @private
   * @param {AnimationEvent} event 
   */
  _onAnimationEnd(event) {
    // Only handle animationend for this element's pulse animation
    if (event && event.target !== this.element) return;

    this.isAnimating = false;
    if (this.element) {
      this.element.classList.remove("beating");
    }

    // If beating was stopped while the animation was playing, stay stopped
    if (!this.isBeating) {
      if (this.element) {
        this.element.style.removeProperty("--beat-duration");
        this.element.style.removeProperty("--beat-delay");
      }
      return;
    }

    // Previous animation is completely finished. Now schedule or trigger the next beat.
    const now = performance.now();
    this._scheduleOrTriggerNextBeat(now);
  }

  /**
   * Evaluates pending or continuous beats and either starts the next animation
   * immediately or schedules it for the expected systolic peak timestamp.
   * 
   * @private
   * @param {number} now - Current high-resolution timestamp.
   */
  _scheduleOrTriggerNextBeat(now) {
    if (!this.isBeating) return;

    // Check if an explicit next beat was scheduled
    if (this.pendingNextBeat) {
      const { nextBeatTimestamp, bpm, once } = this.pendingNextBeat;
      this.bpm = bpm;
      const periodSec = 60 / this.bpm;

      if (once) {
        this.pendingNextBeat = null;
        this.isBeating = false;
        this._startSingleBeatAnimation(periodSec);
        return;
      }

      // If scheduled time is due now or was in the past (completed waiting for previous animation)
      if (nextBeatTimestamp <= now + 16) {
        this.pendingNextBeat = null;
        this._startSingleBeatAnimation(periodSec);
      } else {
        // Scheduled timestamp is in the future: wait until that exact frame
        this._waitForTimestamp(nextBeatTimestamp, periodSec);
      }
      return;
    }

    // Continuous rhythmic pulse fallback: keep beating at the active BPM
    if (this.bpm && this.bpm > 0) {
      const periodSec = 60 / this.bpm;
      this._startSingleBeatAnimation(periodSec);
    }
  }

  /**
   * Waits via requestAnimationFrame until targetTime arrives, then triggers the next beat.
   * 
   * @private
   * @param {number} targetTime - Timestamp to wait for.
   * @param {number} periodSec - Animation period to execute.
   */
  _waitForTimestamp(targetTime, periodSec) {
    if (this.scheduledRafId) {
      cancelAnimationFrame(this.scheduledRafId);
      this.scheduledRafId = null;
    }

    const checkSchedule = (frameTime) => {
      if (!this.isBeating) return;
      if (this.isAnimating) return; // Guard against overlapping triggers

      if (frameTime >= targetTime - 8) {
        this.scheduledRafId = null;
        this.pendingNextBeat = null;
        this._startSingleBeatAnimation(periodSec);
      } else {
        this.scheduledRafId = requestAnimationFrame(checkSchedule);
      }
    };

    this.scheduledRafId = requestAnimationFrame(checkSchedule);
  }

  /**
   * Executes a single complete cycle of the beating animation.
   * 
   * @private
   * @param {number} periodSec - Duration of the beat cycle in seconds.
   */
  _startSingleBeatAnimation(periodSec) {
    if (!this.element || this.isAnimating) return;

    this.isAnimating = true;
    this.activeDurationSec = periodSec;

    this.element.style.setProperty("--beat-duration", `${periodSec.toFixed(3)}s`);

    // Clean restart of single keyframe run
    this.element.classList.remove("beating");
    void this.element.offsetWidth; // Force DOM reflow to restart CSS animation from 0%
    this.element.classList.add("beating");
  }
}

/**
 * Convenience singleton instance and standalone function export for nextBeatUpdate.
 */
let defaultHeartSwellInstance = null;

/**
 * Standalone function to update or schedule the next beat on the default header heart icon.
 * 
 * @param {number} nextBeatTimestamp - DOMHighResTimeStamp of the next beat.
 * @param {number} bpm - Current heart rate in beats per minute.
 * @param {string|HTMLElement} [target=".pulse-icon"] - Optional target element.
 * @returns {HeartSwell} The controller instance.
 */
export function nextBeatUpdate(nextBeatTimestamp, bpm, target = ".pulse-icon") {
  if (!defaultHeartSwellInstance || (target && defaultHeartSwellInstance.element !== document.querySelector(target))) {
    defaultHeartSwellInstance = new HeartSwell(target);
  }
  defaultHeartSwellInstance.nextBeatUpdate(nextBeatTimestamp, bpm);
  return defaultHeartSwellInstance;
}

/**
 * Standalone function to trigger a single swell.
 * 
 * @param {string|HTMLElement} [target=".pulse-icon"] - Target element.
 * @param {number} [durationMs=300] - Duration of swell in milliseconds.
 */
export function swellHeart(target = ".pulse-icon", durationMs = 300) {
  if (!defaultHeartSwellInstance) {
    defaultHeartSwellInstance = new HeartSwell(target);
  }
  defaultHeartSwellInstance.swell(durationMs);
  return defaultHeartSwellInstance;
}
