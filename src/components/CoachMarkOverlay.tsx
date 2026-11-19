import React, { useEffect, useState } from 'react';
import { Play, Sparkles, X } from 'lucide-react';

interface CoachMarkOverlayProps {
  visible: boolean;
  canvasRef: React.RefObject<HTMLDivElement | null>;
  gestureControlsRef: React.RefObject<HTMLDivElement | null>;
  runButtonRef: React.RefObject<HTMLButtonElement | null>;
  onDropSamplePoint: () => void;
  onRunAnimated: () => void;
  onComplete: () => void;
}

interface RectBox {
  top: number;
  left: number;
  width: number;
  height: number;
}

const STEPS = [
  {
    title: '1. Tap Canvas to Plot Data',
    body: 'Click or drag on the 2D studio plot to place custom coordinates. Right-click or hold any cluster for 500ms to attach PDF-ready annotations.',
    cta: 'Drop Sample Point',
  },
  {
    title: '2. Switch Gesture Modes',
    body: 'Use Tap Add or Erase (plus Brush & Pan/Zoom in Developer Mode) to sculpt non-convex shapes, outliers, or custom densities.',
    cta: 'Next Step',
  },
  {
    title: '3. Animate Convergence',
    body: 'Launch K-Means++ or DBSCAN animated iterations and inspect Silhouette, WCSS Inertia, Voronoi boundaries, and Batch PDF exports.',
    cta: 'Run & Start Studio',
  },
];

export const InteractiveCoachMarkOverlay: React.FC<CoachMarkOverlayProps> = ({
  visible,
  canvasRef,
  gestureControlsRef,
  runButtonRef,
  onDropSamplePoint,
  onRunAnimated,
  onComplete,
}) => {
  const [step, setStep] = useState(0);
  const [spotlightRect, setSpotlightRect] = useState<RectBox | null>(null);

  useEffect(() => {
    if (!visible) {
      setStep(0);
      return;
    }

    const measure = () => {
      const targetEl =
        step === 0
          ? canvasRef.current
          : step === 1
            ? gestureControlsRef.current
            : runButtonRef.current;
      if (!targetEl) {
        setSpotlightRect(null);
        return;
      }
      const r = targetEl.getBoundingClientRect();
      const pad = 6;
      setSpotlightRect({
        top: Math.max(8, r.top - pad),
        left: Math.max(8, r.left - pad),
        width: r.width + pad * 2,
        height: r.height + pad * 2,
      });
    };

    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [visible, step, canvasRef, gestureControlsRef, runButtonRef]);

  if (!visible) return null;

  const current = STEPS[step];
  const cardBelow = !spotlightRect || spotlightRect.top + spotlightRect.height + 220 < window.innerHeight;
  const cardTop = spotlightRect
    ? cardBelow
      ? Math.min(window.innerHeight - 210, spotlightRect.top + spotlightRect.height + 14)
      : Math.max(16, spotlightRect.top - 205)
    : 120;
  const cardLeft = spotlightRect
    ? Math.max(16, Math.min(window.innerWidth - 356, spotlightRect.left))
    : Math.max(16, window.innerWidth / 2 - 170);

  const handlePrimaryAction = () => {
    if (step === 0) {
      onDropSamplePoint();
      setStep(1);
    } else if (step === 1) {
      setStep(2);
    } else {
      onRunAnimated();
      onComplete();
    }
  };

  return (
    <div className="fixed inset-0 z-50">
      {/* 4-rect spotlight scrim */}
      {spotlightRect ? (
        <>
          <div
            className="fixed bg-slate-950/75"
            style={{ top: 0, left: 0, right: 0, height: spotlightRect.top }}
          />
          <div
            className="fixed bg-slate-950/75"
            style={{
              top: spotlightRect.top + spotlightRect.height,
              left: 0,
              right: 0,
              bottom: 0,
            }}
          />
          <div
            className="fixed bg-slate-950/75"
            style={{
              top: spotlightRect.top,
              left: 0,
              width: spotlightRect.left,
              height: spotlightRect.height,
            }}
          />
          <div
            className="fixed bg-slate-950/75"
            style={{
              top: spotlightRect.top,
              left: spotlightRect.left + spotlightRect.width,
              right: 0,
              height: spotlightRect.height,
            }}
          />
          <button
            type="button"
            aria-label="Spotlight action"
            onClick={handlePrimaryAction}
            className="fixed rounded-2xl border-2 border-blue-400 shadow-[0_0_0_2px_rgba(96,165,250,0.35)] bg-transparent cursor-pointer"
            style={{
              top: spotlightRect.top,
              left: spotlightRect.left,
              width: spotlightRect.width,
              height: spotlightRect.height,
            }}
          />
        </>
      ) : (
        <div className="fixed inset-0 bg-slate-950/75" />
      )}

      {/* Callout Card */}
      <div
        className="fixed w-[340px] max-w-[calc(100vw-32px)] rounded-2xl border border-blue-500/60 bg-white dark:bg-[#131C31] p-4 shadow-2xl space-y-3"
        style={{ top: cardTop, left: cardLeft }}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-blue-500 shrink-0" />
            <h4 className="font-display text-sm font-bold text-slate-900 dark:text-slate-100">
              {current.title}
            </h4>
          </div>
          <button
            type="button"
            onClick={onComplete}
            className="p-1 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
          {current.body}
        </p>

        <div className="flex items-center justify-between pt-1">
          <div className="flex items-center gap-1.5">
            {STEPS.map((_, idx) => (
              <span
                key={idx}
                className={`h-1.5 rounded-full transition-all ${
                  idx === step ? 'w-5 bg-blue-500' : 'w-1.5 bg-slate-300 dark:bg-slate-600'
                }`}
              />
            ))}
          </div>

          <div className="flex items-center gap-2">
            {step > 0 && (
              <button
                type="button"
                onClick={() => setStep((s) => Math.max(0, s - 1))}
                className="text-xs font-semibold text-slate-500 hover:text-slate-800 dark:text-slate-400"
              >
                Back
              </button>
            )}
            <button
              type="button"
              onClick={handlePrimaryAction}
              className="inline-flex items-center gap-1 rounded-lg bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 text-xs font-semibold"
            >
              {step === 2 && <Play className="w-3 h-3" />}
              {current.cta}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
