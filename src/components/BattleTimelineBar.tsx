import { useMemo, useState } from 'react';
import type {
  SpineAudioEventRef,
  SpineCommandEffectRef,
  SpineVideoEventRef,
} from '../types/sprite';

export interface TimelineEventMarker {
  id: string;
  time: number;
  kind: 'particle' | 'impact' | 'audio' | 'video';
  label: string;
}

interface BattleTimelineBarProps {
  currentTime: number;
  duration: number;
  effectRefs: SpineCommandEffectRef[];
  audioRefs: SpineAudioEventRef[];
  videoRefs: SpineVideoEventRef[];
  onSeek: (timeSec: number) => void;
}

const MARKER_META: Record<
  TimelineEventMarker['kind'],
  { label: string; dotClass: string; textClass: string }
> = {
  particle: {
    label: 'Partícula',
    dotClass: 'bg-orange-400',
    textClass: 'text-orange-300',
  },
  impact: {
    label: 'Impacto',
    dotClass: 'bg-rose-500',
    textClass: 'text-rose-300',
  },
  audio: {
    label: 'Áudio',
    dotClass: 'bg-sky-400',
    textClass: 'text-sky-300',
  },
  video: {
    label: 'Vídeo',
    dotClass: 'bg-cyan-300',
    textClass: 'text-cyan-300',
  },
};

export function BattleTimelineBar({
  currentTime,
  duration,
  effectRefs,
  audioRefs,
  videoRefs,
  onSeek,
}: BattleTimelineBarProps) {
  const [hoveredMarker, setHoveredMarker] = useState<TimelineEventMarker | null>(null);

  const markers = useMemo<TimelineEventMarker[]>(() => {
    const list: TimelineEventMarker[] = [];
    effectRefs.forEach((ref, idx) => {
      list.push({
        id: `eff-${idx}-${ref.spineId}-${ref.startTime}`,
        time: Math.max(0, ref.startTime),
        kind: ref.isSelfOrScreen ? 'particle' : 'impact',
        label: `${ref.isSelfOrScreen ? 'Partícula' : 'Impacto'}: ${ref.spineId} (${ref.animName})`,
      });
    });
    audioRefs.forEach((ref, idx) => {
      list.push({
        id: `aud-${idx}-${ref.soundName}-${ref.time}`,
        time: Math.max(0, ref.time),
        kind: 'audio',
        label: `Áudio: ${ref.soundName}`,
      });
    });
    videoRefs.forEach((ref, idx) => {
      list.push({
        id: `vid-${idx}-${ref.resolvedName}-${ref.time}`,
        time: Math.max(0, ref.time),
        kind: 'video',
        label: `Vídeo: ${ref.resolvedName}`,
      });
    });
    return list.sort((a, b) => a.time - b.time);
  }, [effectRefs, audioRefs, videoRefs]);

  const counts = useMemo(() => {
    let particle = 0;
    let impact = 0;
    let audio = 0;
    let video = 0;
    for (const m of markers) {
      if (m.kind === 'particle') particle++;
      else if (m.kind === 'impact') impact++;
      else if (m.kind === 'audio') audio++;
      else video++;
    }
    return { particle, impact, audio, video };
  }, [markers]);

  const safeDuration = Math.max(0.01, duration);
  const clampedTime = Math.min(safeDuration, Math.max(0, currentTime));
  const progressPct = Math.min(100, Math.max(0, (clampedTime / safeDuration) * 100));

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2.5 text-[11px] font-mono text-slate-400 tabular-nums">
        <span className="w-11 text-right text-slate-300">{clampedTime.toFixed(2)}s</span>

        {/* Interactive Track + Event Markers */}
        <div className="relative flex-1 py-2">
          {/* Base rail */}
          <div className="relative h-2 w-full rounded-full bg-white/[0.08]">
            {/* Filled progress */}
            <div
              className="pointer-events-none absolute inset-y-0 left-0 rounded-full bg-orange-500/85"
              style={{ width: `${progressPct}%` }}
            />

            {/* Event tick marks */}
            {duration > 0 &&
              markers.map((marker) => {
                const leftPct = Math.min(99.5, Math.max(0.5, (marker.time / safeDuration) * 100));
                const meta = MARKER_META[marker.kind];
                return (
                  <button
                    key={marker.id}
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onSeek(Math.min(duration, marker.time));
                    }}
                    onMouseEnter={() => setHoveredMarker(marker)}
                    onMouseLeave={() => setHoveredMarker((prev) => (prev?.id === marker.id ? null : prev))}
                    onFocus={() => setHoveredMarker(marker)}
                    onBlur={() => setHoveredMarker((prev) => (prev?.id === marker.id ? null : prev))}
                    title={`${marker.label} · ${Math.round(marker.time * 1000)}ms`}
                    aria-label={`${marker.label} em ${marker.time.toFixed(2)}s`}
                    style={{ left: `${leftPct}%` }}
                    className={`absolute top-1/2 z-20 h-3.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-xs ${meta.dotClass} opacity-95 ring-1 ring-[#0C0F16] transition-transform hover:scale-y-125 hover:scale-x-125 cursor-pointer`}
                  />
                );
              })}
          </div>

          {/* Native accessible range slider overlay for smooth scrubbing */}
          <input
            type="range"
            min={0}
            max={Math.max(0.01, duration)}
            step={0.01}
            value={clampedTime}
            onChange={(e) => onSeek(Number(e.target.value))}
            aria-label="Linha do tempo da animação"
            className="absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0"
          />
        </div>

        <span className="w-11 text-slate-500">{duration.toFixed(2)}s</span>
      </div>

      {/* Unboxed Legend & Active Marker Inspection Line */}
      {markers.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-1 text-[11px] text-slate-400 tabular-nums">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
            {counts.particle > 0 && (
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-xs bg-orange-400" aria-hidden="true" />
                <span>Partículas ({counts.particle})</span>
              </span>
            )}
            {counts.impact > 0 && (
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-xs bg-rose-500" aria-hidden="true" />
                <span>Impactos ({counts.impact})</span>
              </span>
            )}
            {counts.audio > 0 && (
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-xs bg-sky-400" aria-hidden="true" />
                <span>Áudios ({counts.audio})</span>
              </span>
            )}
            {counts.video > 0 && (
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-xs bg-cyan-300" aria-hidden="true" />
                <span>Vídeos ({counts.video})</span>
              </span>
            )}
          </div>

          {hoveredMarker && (
            <span className={`truncate font-mono text-[11px] ${MARKER_META[hoveredMarker.kind].textClass}`}>
              {Math.round(hoveredMarker.time * 1000)}ms · {hoveredMarker.label}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
