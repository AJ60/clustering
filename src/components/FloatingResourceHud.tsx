import React, { useEffect, useRef, useState } from 'react';
import { Activity, ExternalLink, GripHorizontal, Thermometer, X } from 'lucide-react';
import { StarClusterPlan } from '../types/starCluster';

interface FloatingResourceHudProps {
  open: boolean;
  plan: StarClusterPlan;
  onClose: () => void;
}

export const FloatingResourceHud: React.FC<FloatingResourceHudProps> = ({
  open,
  plan,
  onClose,
}) => {
  const [pos, setPos] = useState({ right: 24, bottom: 24 });
  const draggingRef = useRef<{ startX: number; startY: number; origRight: number; origBottom: number } | null>(
    null
  );
  const [pipNote, setPipNote] = useState<string | null>(null);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!draggingRef.current) return;
      const dx = e.clientX - draggingRef.current.startX;
      const dy = e.clientY - draggingRef.current.startY;
      setPos({
        right: Math.max(12, Math.min(window.innerWidth - 350, draggingRef.current.origRight - dx)),
        bottom: Math.max(12, Math.min(window.innerHeight - 160, draggingRef.current.origBottom - dy)),
      });
    };
    const onUp = () => {
      draggingRef.current = null;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  if (!open) return null;

  const activeNodes = plan.nodes.filter((n) => n.isConnected && !n.pruned);
  const totalTok = plan.estimatedClusterTokPerSec;

  const handleDocumentPip = async () => {
    const docPip = (window as unknown as { documentPictureInPicture?: { requestWindow: (opts: { width: number; height: number }) => Promise<Window> } }).documentPictureInPicture;
    if (!docPip) {
      setPipNote('Pinned as draggable HUD overlay (Browser PiP unavailable in this frame)');
      setTimeout(() => setPipNote(null), 3500);
      return;
    }
    try {
      const pipWin = await docPip.requestWindow({ width: 340, height: 260 });
      const rows = activeNodes
        .map(
          (n) =>
            `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #1e293b;font-size:12px;">
              <span>${n.label.slice(0, 18)}</span>
              <span style="font-family:monospace;">CPU ${n.cpuUsagePct ?? 12}% · GPU ${n.gpuUsagePct ?? 0}% · ${n.tempC.toFixed(0)}°C · ${n.estimatedTokPerSec} t/s</span>
            </div>`
        )
        .join('');
      pipWin.document.body.style.cssText =
        'margin:0;padding:12px;background:#0b1120;color:#f1f5f9;font-family:system-ui,sans-serif;';
      pipWin.document.body.innerHTML = `<div style="font-weight:600;margin-bottom:8px;">Silica HUD · ${totalTok} tok/s</div>${rows}`;
    } catch {
      setPipNote('Using draggable overlay HUD');
      setTimeout(() => setPipNote(null), 2500);
    }
  };

  return (
    <aside
      aria-label="Floating Resource Monitor HUD"
      data-testid="floating-resource-hud"
      style={{ right: `${pos.right}px`, bottom: `${pos.bottom}px` }}
      className="fixed z-40 w-[336px] rounded-xl border border-slate-300 dark:border-slate-700 bg-white/95 dark:bg-[#0E1525]/95 backdrop-blur-md shadow-xl"
    >
      <div
        onMouseDown={(e) => {
          draggingRef.current = {
            startX: e.clientX,
            startY: e.clientY,
            origRight: pos.right,
            origBottom: pos.bottom,
          };
        }}
        className="flex items-center justify-between px-3.5 py-2.5 border-b border-slate-200 dark:border-slate-800 cursor-move select-none"
      >
        <div className="flex items-center gap-2 text-xs font-semibold text-slate-900 dark:text-slate-100">
          <GripHorizontal className="w-3.5 h-3.5 text-slate-400" />
          <Activity className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
          <span>Resource HUD</span>
          <span className="font-mono-num text-emerald-700 dark:text-emerald-400">
            {totalTok} tok/s
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={handleDocumentPip}
            aria-label="Pop out HUD window"
            title="Pop out HUD"
            className="p-1 rounded text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close Resource HUD"
            className="p-1 rounded text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <div className="p-3 space-y-2.5 max-h-[320px] overflow-y-auto">
        {activeNodes.map((node) => (
          <div
            key={node.nodeId}
            className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#111827] px-3 py-2"
          >
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium text-slate-900 dark:text-slate-100 truncate pr-2">
                {node.label}
              </span>
              <span className="font-mono-num text-emerald-700 dark:text-emerald-400 shrink-0">
                {node.estimatedTokPerSec} tok/s
              </span>
            </div>
            <div className="mt-1.5 grid grid-cols-3 gap-2 text-[11px] font-mono-num text-slate-600 dark:text-slate-400">
              <span>CPU {node.cpuUsagePct ?? 14}%</span>
              <span>GPU {node.gpuUsagePct ?? (node.safeVramMb > 0 ? 18 : 0)}%</span>
              <span className="inline-flex items-center justify-end gap-0.5">
                <Thermometer className="w-3 h-3" />
                {node.tempC.toFixed(0)}°C
              </span>
            </div>
          </div>
        ))}
        {pipNote && (
          <p className="text-[11px] text-slate-500 dark:text-slate-400">{pipNote}</p>
        )}
      </div>
    </aside>
  );
};
