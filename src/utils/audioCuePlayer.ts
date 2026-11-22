import type { SpineAudioEventRef } from '../types/sprite';

/**
 * Lightweight browser audio cue player for synchronized Spine animation SFX
 * and standalone character voice previews.
 */
class AudioCuePlayer {
  private activeAudios = new Set<HTMLAudioElement>();
  private preloadedUrls = new Set<string>();

  preloadAudioUrls(urls: string[]) {
    if (typeof Audio === 'undefined') return;
    for (const url of urls) {
      if (!url || this.preloadedUrls.has(url)) continue;
      if (this.preloadedUrls.size > 60) {
        const oldest = this.preloadedUrls.values().next().value;
        if (oldest) this.preloadedUrls.delete(oldest);
      }
      this.preloadedUrls.add(url);
      try {
        const audio = new Audio();
        audio.preload = 'auto';
        audio.src = url;
      } catch {
        // ignore preload failures
      }
    }
  }

  playOneShot(
    url: string,
    volume = 0.85,
    muted = false,
    onEnded?: () => void
  ): HTMLAudioElement | null {
    if (muted || !url || typeof Audio === 'undefined') return null;

    // Prevent runaway overlap if a rapid loop fires many sounds
    if (this.activeAudios.size >= 10) {
      const oldest = this.activeAudios.values().next().value;
      if (oldest) {
        try {
          oldest.pause();
          oldest.currentTime = 0;
        } catch {
          // ignore
        }
        this.activeAudios.delete(oldest);
      }
    }

    try {
      const audio = new Audio(url);
      audio.volume = Math.max(0, Math.min(1, volume));
      const cleanup = () => {
        this.activeAudios.delete(audio);
        onEnded?.();
      };
      audio.addEventListener('ended', cleanup, { once: true });
      audio.addEventListener('error', cleanup, { once: true });
      this.activeAudios.add(audio);

      const playPromise = audio.play();
      if (playPromise && typeof playPromise.catch === 'function') {
        playPromise.catch(() => {
          this.activeAudios.delete(audio);
          onEnded?.();
        });
      }
      return audio;
    } catch {
      onEnded?.();
      return null;
    }
  }

  setVolume(volume: number) {
    const safeVol = Math.max(0, Math.min(1, volume));
    for (const audio of this.activeAudios) {
      try {
        audio.volume = safeVol;
      } catch {
        // ignore
      }
    }
  }

  stopAll() {
    for (const audio of this.activeAudios) {
      try {
        audio.pause();
        audio.currentTime = 0;
      } catch {
        // ignore
      }
    }
    this.activeAudios.clear();
  }

  /**
   * Fires any audio cue whose timestamp lies in (prevTime, nextTime] (or wraps across loop boundary).
   * When prevTime < 0 (initial frame at t=0), cues at time === 0 also trigger cleanly.
   */
  triggerCuesInRange(
    cues: SpineAudioEventRef[],
    prevTime: number,
    nextTime: number,
    loopWrapped: boolean,
    resolveUrl: (soundName: string) => string | null,
    volume: number,
    muted: boolean
  ) {
    if (muted || cues.length === 0) return;

    for (const cue of cues) {
      let shouldFire = false;
      if (prevTime < 0) {
        shouldFire = cue.time >= 0 && cue.time <= nextTime;
      } else if (!loopWrapped) {
        shouldFire = cue.time > prevTime && cue.time <= nextTime;
      } else {
        // Wrapped from prevTime -> end, and 0 -> nextTime
        shouldFire = cue.time > prevTime || (cue.time >= 0 && cue.time <= nextTime);
      }

      if (shouldFire) {
        const url = resolveUrl(cue.soundName);
        if (url) {
          this.playOneShot(url, volume, muted);
        }
      }
    }
  }
}

export const audioCuePlayer = new AudioCuePlayer();
