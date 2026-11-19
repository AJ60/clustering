import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AutoFixAction,
  DeviceTelemetryState,
  DiagnosticSeverity,
} from '../types/clustering';
import { ClusterQrCodec } from '../service/nodeClusterService';
import {
  Activity,
  AlertTriangle,
  BatteryCharging,
  Camera,
  CheckCircle2,
  Cpu,
  Laptop,
  Play,
  QrCode,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Square,
  Terminal,
  Usb,
  Wifi,
  Wrench,
  X,
  Zap,
} from 'lucide-react';

interface HardenedNodeDashboardProps {
  telemetry: DeviceTelemetryState;
  onRecalibrate: () => void;
  onStartWorker: () => void;
  onStopWorker: () => void;
  onAutoDetectMaster: () => void;
  onPairQrPayload: (raw: string) => boolean;
  onToggleBindMode: (usbOnly: boolean) => void;
  onUpdateSecret: (secret: string) => void;
  onSimulateShedLayers: () => void;
  onRunDiagnostics: () => void;
  onApplyAutoFix: (action: AutoFixAction) => void;
}

const QrMatrixCanvas: React.FC<{ payload: string; size?: number }> = ({
  payload,
  size = 188,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const matrix = useMemo(() => ClusterQrCodec.encodeUriTo21x21Matrix(payload), [payload]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const cells = 21;
    const quiet = 1;
    const totalCells = cells + quiet * 2;
    const cellPx = size / totalCells;

    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, size, size);

    ctx.fillStyle = '#0F172A';
    for (let r = 0; r < cells; r++) {
      for (let c = 0; c < cells; c++) {
        if (matrix[r][c]) {
          ctx.fillRect(
            (c + quiet) * cellPx,
            (r + quiet) * cellPx,
            Math.ceil(cellPx),
            Math.ceil(cellPx)
          );
        }
      }
    }
  }, [matrix, size]);

  return (
    <canvas
      ref={canvasRef}
      width={size}
      height={size}
      className="rounded-xl border border-slate-300 bg-white shadow-xs"
    />
  );
};

interface CameraQrScannerDialogProps {
  activePayload: string;
  onPairPayload: (raw: string) => boolean;
  onClose: () => void;
}

export const CameraQrScannerDialog: React.FC<CameraQrScannerDialogProps> = ({
  activePayload,
  onPairPayload,
  onClose,
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const sampleCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [manualUri, setManualUri] = useState(activePayload);
  const [decodeNotice, setDecodeNotice] = useState<string | null>(null);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer: number | null = null;
    let cancelled = false;

    const startCamera = async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setCameraError('Browser camera API unavailable. Use Instant Frame Decode or paste a pairing URI.');
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
          setCameraActive(true);
        }

        // Sample center ROI at ~3 FPS using ClusterQrCodec luma grid decoder
        timer = window.setInterval(() => {
          const video = videoRef.current;
          const canvas = sampleCanvasRef.current;
          if (!video || !canvas || video.videoWidth < 60) return;
          const ctx = canvas.getContext('2d');
          if (!ctx) return;
          const side = 168;
          canvas.width = side;
          canvas.height = side;
          const minDim = Math.min(video.videoWidth, video.videoHeight);
          const sx = (video.videoWidth - minDim) / 2;
          const sy = (video.videoHeight - minDim) / 2;
          ctx.drawImage(video, sx, sy, minDim, minDim, 0, 0, side, side);
          const img = ctx.getImageData(0, 0, side, side).data;

          // Compute adaptive grayscale threshold
          let lumSum = 0;
          const lums = new Float32Array(side * side);
          for (let i = 0; i < side * side; i++) {
            const l = 0.299 * img[i * 4] + 0.587 * img[i * 4 + 1] + 0.114 * img[i * 4 + 2];
            lums[i] = l;
            lumSum += l;
          }
          const thresh = lumSum / (side * side);
          const matrix: boolean[][] = Array.from({ length: 21 }, (_, r) =>
            Array.from({ length: 21 }, (_, c) => {
              const px = Math.floor(((c + 0.5) / 21) * side);
              const py = Math.floor(((r + 0.5) / 21) * side);
              return lums[py * side + px] < thresh;
            })
          );
          const decoded = ClusterQrCodec.decode21x21MatrixToUri(matrix);
          if (decoded) {
            setManualUri(decoded);
            setDecodeNotice(`CRC-8 QR Verified: ${decoded}`);
            onPairPayload(decoded);
            onClose();
          }
        }, 350);
      } catch {
        setCameraError(
          'Camera permission declined or no webcam attached. Use Instant Frame Decode or preset endpoints below.'
        );
      }
    };

    startCamera();

    return () => {
      cancelled = true;
      if (timer !== null) window.clearInterval(timer);
      if (stream) stream.getTracks().forEach((t) => t.stop());
    };
  }, [onClose, onPairPayload]);

  const handleInstantSelfDecode = () => {
    const encoded = ClusterQrCodec.encodeUriTo21x21Matrix(manualUri);
    const decoded = ClusterQrCodec.decode21x21MatrixToUri(encoded);
    if (decoded) {
      setDecodeNotice(`21×21 CRC-8 Decoded: ${decoded}`);
      onPairPayload(decoded);
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/75 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="w-full max-w-2xl max-h-[90vh] flex flex-col rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#131C31] shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-700">
          <div className="flex items-center gap-2">
            <QrCode className="w-5 h-5 text-blue-500" />
            <div>
              <h3 className="font-display text-base font-bold text-slate-900 dark:text-slate-100">
                Pair with Cluster Master (21×21 CRC-8 QR)
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Scan QR code from <code className="font-mono-num">clusterd</code> Web UI or pair via USB / LAN URI.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 grid grid-cols-1 md:grid-cols-2 gap-5">
          {/* Left: Camera Viewfinder */}
          <div className="space-y-3">
            <div className="text-xs font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400 flex items-center gap-1.5">
              <Camera className="w-3.5 h-3.5 text-blue-500" />
              Live Camera Viewfinder
            </div>
            <div className="relative aspect-square w-full rounded-xl overflow-hidden border border-slate-300 dark:border-slate-700 bg-slate-950 flex items-center justify-center">
              <video
                ref={videoRef}
                muted
                playsInline
                className={`w-full h-full object-cover ${cameraActive ? 'block' : 'hidden'}`}
              />
              <canvas ref={sampleCanvasRef} className="hidden" />
              {cameraActive ? (
                <div className="absolute inset-8 border-2 border-teal-400/80 rounded-xl pointer-events-none" />
              ) : (
                <div className="p-4 text-center text-xs text-slate-400">
                  {cameraError ?? 'Initializing camera sensor...'}
                </div>
              )}
            </div>

            <button
              type="button"
              onClick={handleInstantSelfDecode}
              className="w-full inline-flex items-center justify-center gap-1.5 rounded-xl bg-teal-600 hover:bg-teal-500 text-white px-3 py-2 text-xs font-semibold"
            >
              <Zap className="w-3.5 h-3.5" />
              Instant Decode Active QR Frame
            </button>
          </div>

          {/* Right: Generated Pairing QR & Manual URI */}
          <div className="space-y-3">
            <div className="text-xs font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              My Node QR Payload
            </div>
            <div className="flex justify-center py-1">
              <QrMatrixCanvas payload={manualUri} size={172} />
            </div>

            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                onClick={() =>
                  setManualUri('clusterd://pair?master=127.0.0.1:8080&rpc=50052&secret=clusterd-default-hmac-key')
                }
                className="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-[#1E293B] px-2.5 py-1 text-[11px] font-mono-num text-slate-700 dark:text-slate-200 hover:border-blue-500"
              >
                USB 127.0.0.1:8080
              </button>
              <button
                type="button"
                onClick={() =>
                  setManualUri('clusterd://pair?master=192.168.1.42:8080&rpc=50052&secret=clusterd-lan-token')
                }
                className="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-[#1E293B] px-2.5 py-1 text-[11px] font-mono-num text-slate-700 dark:text-slate-200 hover:border-blue-500"
              >
                LAN 192.168.1.42
              </button>
            </div>

            <input
              type="text"
              value={manualUri}
              onChange={(e) => setManualUri(e.target.value)}
              className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-[#0B1120] px-3 py-2 text-xs font-mono-num text-slate-900 dark:text-slate-100 focus:outline-hidden focus:border-blue-500"
            />

            {decodeNotice && (
              <div className="text-[11px] font-mono-num text-emerald-600 dark:text-emerald-400">
                {decodeNotice}
              </div>
            )}

            <button
              type="button"
              onClick={() => {
                if (onPairPayload(manualUri)) onClose();
              }}
              className="w-full rounded-xl bg-blue-600 hover:bg-blue-500 text-white py-2 text-xs font-semibold"
            >
              Pair & Connect Worker
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

function severityBadge(sev: DiagnosticSeverity) {
  if (sev === 'OK') {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 px-2 py-0.5 text-[10px] font-bold">
        <CheckCircle2 className="w-3 h-3" />
        OK
      </span>
    );
  }
  if (sev === 'WARNING') {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-amber-500/15 text-amber-700 dark:text-amber-300 px-2 py-0.5 text-[10px] font-bold">
        <AlertTriangle className="w-3 h-3" />
        TIP
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-red-500/15 text-red-700 dark:text-red-300 px-2 py-0.5 text-[10px] font-bold">
      <ShieldAlert className="w-3 h-3" />
      FIX
    </span>
  );
}

export const HardenedNodeDashboard: React.FC<HardenedNodeDashboardProps> = ({
  telemetry,
  onRecalibrate,
  onStartWorker,
  onStopWorker,
  onAutoDetectMaster,
  onPairQrPayload,
  onToggleBindMode,
  onUpdateSecret,
  onSimulateShedLayers,
  onRunDiagnostics,
  onApplyAutoFix,
}) => {
  const [showQrModal, setShowQrModal] = useState(false);

  const isRunning =
    telemetry.workerState === 'RUNNING_USB' || telemetry.workerState === 'RUNNING_WIFI';
  const cal = telemetry.calibration;

  return (
    <div className="space-y-4 pb-8">
      {/* 1. Simple Hero Connect Card */}
      <div className="rounded-2xl border border-slate-200 dark:border-slate-700/90 bg-white dark:bg-[#131C31] p-5 shadow-xs space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-start gap-3">
            <div
              className={`w-11 h-11 rounded-xl flex items-center justify-center shrink-0 ${
                isRunning
                  ? 'bg-emerald-500/15 text-emerald-500'
                  : 'bg-blue-600/15 text-blue-500'
              }`}
            >
              <Laptop className="w-6 h-6" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="font-display text-base font-bold text-slate-900 dark:text-slate-100">
                  {isRunning
                    ? 'Sharing Compute Safely'
                    : telemetry.workerState === 'SHEDDING_MEMORY'
                      ? 'Paused — Memory Shedded'
                      : 'Ready to Pair Worker Node'}
                </h2>
                <span
                  className={`rounded-md px-2 py-0.5 text-[10px] font-mono-num font-bold ${
                    isRunning
                      ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                      : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300'
                  }`}
                >
                  {telemetry.workerState}
                </span>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                {telemetry.pairedMasterAddress} • Safe RAM cap ≤ 50% ({telemetry.safeCapMb} MB)
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={onAutoDetectMaster}
              disabled={telemetry.isScanningMaster}
              className="inline-flex items-center gap-1.5 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white px-3.5 py-2 text-xs font-semibold shadow-xs"
            >
              <RefreshCw
                className={`w-3.5 h-3.5 ${telemetry.isScanningMaster ? 'animate-spin' : ''}`}
              />
              {telemetry.isScanningMaster ? 'Scanning...' : 'Auto-Connect'}
            </button>

            <button
              type="button"
              onClick={() => setShowQrModal(true)}
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#1E293B] px-3.5 py-2 text-xs font-semibold text-slate-800 dark:text-slate-100 hover:border-blue-500"
            >
              <QrCode className="w-3.5 h-3.5 text-teal-500" />
              Scan / My QR
            </button>

            {isRunning ? (
              <button
                type="button"
                onClick={onStopWorker}
                className="inline-flex items-center gap-1.5 rounded-xl bg-red-600/15 text-red-600 dark:text-red-300 border border-red-500/35 px-3.5 py-2 text-xs font-semibold hover:bg-red-600/25"
              >
                <Square className="w-3.5 h-3.5" />
                Stop & Free Memory
              </button>
            ) : (
              <button
                type="button"
                onClick={onStartWorker}
                className="inline-flex items-center gap-1.5 rounded-xl bg-teal-600 hover:bg-teal-500 text-white px-3.5 py-2 text-xs font-semibold"
              >
                <Play className="w-3.5 h-3.5" />
                Start Sharing
              </button>
            )}
          </div>
        </div>
      </div>

      {/* 2. Auto-Calibrated Health & Safety Card */}
      <div className="rounded-2xl border border-slate-200 dark:border-slate-700/90 bg-white dark:bg-[#131C31] p-5 shadow-xs space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Cpu className="w-4 h-4 text-blue-500" />
            <h3 className="font-display text-sm font-bold text-slate-900 dark:text-slate-100">
              Auto-Calibrated Device Health
            </h3>
            <span className="rounded-md bg-blue-500/15 text-blue-600 dark:text-blue-300 px-2 py-0.5 text-[10px] font-bold">
              {cal.tierLabel}
            </span>
          </div>
          <button
            type="button"
            onClick={onRecalibrate}
            disabled={cal.isCalibrating}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#1E293B] px-3 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:border-blue-500"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${cal.isCalibrating ? 'animate-spin' : ''}`} />
            {cal.isCalibrating ? 'Calibrating...' : 'Re-Tune Speed'}
          </button>
        </div>

        <p className="text-xs text-slate-600 dark:text-slate-300">{cal.summarySentence}</p>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
          <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#1E293B]/60 p-3">
            <div className="text-[10px] font-semibold uppercase text-slate-500 dark:text-slate-400">
              Compute Score
            </div>
            <div className="text-base font-mono-num font-bold text-slate-900 dark:text-slate-100 mt-0.5">
              {cal.performanceScore}/100
            </div>
            <div className="text-[10.5px] text-slate-500 mt-0.5">
              {cal.benchmarkDurationMs}ms float bench
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#1E293B]/60 p-3">
            <div className="text-[10px] font-semibold uppercase text-slate-500 dark:text-slate-400">
              Safe RAM Cap
            </div>
            <div className="text-base font-mono-num font-bold text-emerald-600 dark:text-emerald-400 mt-0.5">
              {cal.recommendedSafeRamMb} MB
            </div>
            <div className="text-[10.5px] text-slate-500 mt-0.5">
              of {telemetry.totalRamMb} MB total
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#1E293B]/60 p-3">
            <div className="text-[10px] font-semibold uppercase text-slate-500 dark:text-slate-400">
              Backend & Cores
            </div>
            <div className="text-xs font-bold text-slate-900 dark:text-slate-100 mt-1 truncate">
              {cal.recommendedBackendLabel}
            </div>
            <div className="text-[10.5px] font-mono-num text-slate-500 mt-0.5">
              {cal.recommendedThreads} threads • {cal.estimatedLayerCapacity} layers
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#1E293B]/60 p-3">
            <div className="text-[10px] font-semibold uppercase text-slate-500 dark:text-slate-400 flex items-center gap-1">
              <BatteryCharging className="w-3 h-3 text-emerald-500" />
              Battery & Heat
            </div>
            <div className="text-base font-mono-num font-bold text-slate-900 dark:text-slate-100 mt-0.5">
              {telemetry.batteryPercent}% • {telemetry.temperatureCelsius.toFixed(1)}°C
            </div>
            <div className="text-[10.5px] text-slate-500 mt-0.5">
              {telemetry.isPluggedIn ? 'AC / Charging' : 'Battery Power'}
            </div>
          </div>
        </div>
      </div>

      {/* 3. Auto-Diagnosis & 1-Click Troubleshooter */}
      <div className="rounded-2xl border border-slate-200 dark:border-slate-700/90 bg-white dark:bg-[#131C31] p-5 shadow-xs space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-teal-500" />
            <h3 className="font-display text-sm font-bold text-slate-900 dark:text-slate-100">
              Connection Troubleshooter (6 Health Checks)
            </h3>
          </div>
          <button
            type="button"
            onClick={onRunDiagnostics}
            disabled={telemetry.isDiagnosing}
            className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 dark:bg-blue-600 hover:opacity-90 text-white px-3 py-1.5 text-xs font-semibold"
          >
            <Activity className={`w-3.5 h-3.5 ${telemetry.isDiagnosing ? 'animate-pulse' : ''}`} />
            {telemetry.isDiagnosing ? 'Running Checks...' : 'Run Auto-Diagnosis'}
          </button>
        </div>

        {telemetry.diagnosticReport ? (
          <div className="space-y-2.5 pt-1">
            <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0B1120]/60 p-3 flex items-center justify-between gap-2">
              <div>
                <div className="text-xs font-bold text-slate-900 dark:text-slate-100">
                  {telemetry.diagnosticReport.headline}
                </div>
                <div className="text-[11px] text-slate-500 dark:text-slate-400">
                  {telemetry.diagnosticReport.subtext}
                </div>
              </div>
              <span className="text-[10px] font-mono-num text-slate-400">
                {telemetry.diagnosticReport.ranAtLabel}
              </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {telemetry.diagnosticReport.checks.map((chk) => (
                <div
                  key={chk.id}
                  className="rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#1E293B]/50 p-3 space-y-1.5"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-bold text-slate-900 dark:text-slate-100">
                      {chk.title}
                    </span>
                    {severityBadge(chk.severity)}
                  </div>
                  <div className="text-[11px] font-medium text-slate-700 dark:text-slate-200">
                    {chk.statusText}
                  </div>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400">
                    {chk.plainEnglishTip}
                  </p>
                  {chk.fixAction && (
                    <button
                      type="button"
                      onClick={() => onApplyAutoFix(chk.fixAction!)}
                      className="inline-flex items-center gap-1 rounded-lg bg-blue-600/15 text-blue-600 dark:text-blue-300 px-2.5 py-1 text-[11px] font-semibold hover:bg-blue-600/25"
                    >
                      <Wrench className="w-3 h-3" />
                      1-Click Fix
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        ) : (
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Click "Run Auto-Diagnosis" to verify calibration, USB/LAN transport, master reachability, memory headroom, and battery thermal guard.
          </p>
        )}
      </div>

      {/* 4. Developer Mode Raw Telemetry & Bind Controls */}
      {telemetry.developerModeEnabled && (
        <div className="rounded-2xl border border-slate-200 dark:border-slate-700/90 bg-white dark:bg-[#131C31] p-5 shadow-xs space-y-4">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <SlidersHorizontal className="w-4 h-4 text-amber-500" />
              <h3 className="font-display text-sm font-bold text-slate-900 dark:text-slate-100">
                Developer Node Telemetry & Security Controls
              </h3>
            </div>
            <span className="text-[10.5px] font-mono-num text-slate-500">
              {telemetry.webglRendererName}
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {/* Bind Mode Toggle */}
            <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#1E293B]/60 p-3 space-y-2">
              <div className="text-xs font-semibold text-slate-700 dark:text-slate-200">
                Transport Bind Address ({telemetry.bindAddress})
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => onToggleBindMode(true)}
                  className={`flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg py-1.5 text-xs font-semibold border ${
                    telemetry.usbLoopbackOnly
                      ? 'bg-blue-600 text-white border-blue-600'
                      : 'border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300'
                  }`}
                >
                  <Usb className="w-3.5 h-3.5" />
                  USB Loopback
                </button>
                <button
                  type="button"
                  onClick={() => onToggleBindMode(false)}
                  className={`flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg py-1.5 text-xs font-semibold border ${
                    !telemetry.usbLoopbackOnly
                      ? 'bg-blue-600 text-white border-blue-600'
                      : 'border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300'
                  }`}
                >
                  <Wifi className="w-3.5 h-3.5" />
                  Wi-Fi LAN
                </button>
              </div>
            </div>

            {/* Cluster Secret & 32-Byte Auth Token Preview */}
            <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#1E293B]/60 p-3 space-y-1.5">
              <div className="text-xs font-semibold text-slate-700 dark:text-slate-200">
                Keyed Auth Secret & 32-Byte Token
              </div>
              <input
                type="text"
                value={telemetry.clusterSecret}
                onChange={(e) => onUpdateSecret(e.target.value)}
                className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#0B1120] px-2.5 py-1 text-xs font-mono-num text-slate-900 dark:text-slate-100"
              />
              <div className="text-[10.5px] font-mono-num text-slate-500 dark:text-slate-400 truncate">
                Token: {telemetry.authTokenHex}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs font-mono-num text-slate-600 dark:text-slate-300">
              Active Layers: {telemetry.activeLayersAssigned} • Handshakes: {telemetry.handshakesCompleted} • Trim Level: {telemetry.lastTrimLevel}
            </div>
            <button
              type="button"
              onClick={onSimulateShedLayers}
              className="inline-flex items-center gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs font-semibold text-amber-700 dark:text-amber-300 hover:bg-amber-500/20"
            >
              <ShieldAlert className="w-3.5 h-3.5" />
              Simulate SHED_LAYERS
            </button>
          </div>

          {/* Raw Event Log */}
          <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-950 p-3 space-y-1.5">
            <div className="flex items-center gap-1.5 text-[11px] font-mono-num font-bold text-slate-400">
              <Terminal className="w-3.5 h-3.5 text-teal-400" />
              Worker Event Stream
            </div>
            <div className="max-h-36 overflow-y-auto space-y-0.5 text-[11px] font-mono-num text-emerald-400">
              {telemetry.eventLogs.map((line, idx) => (
                <div key={idx}>{line}</div>
              ))}
            </div>
          </div>
        </div>
      )}

      {showQrModal && (
        <CameraQrScannerDialog
          activePayload={telemetry.pairingQrPayload}
          onPairPayload={onPairQrPayload}
          onClose={() => setShowQrModal(false)}
        />
      )}
    </div>
  );
};
