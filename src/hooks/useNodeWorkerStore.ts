import { useCallback, useEffect, useState } from 'react';
import { AutoFixAction, DeviceTelemetryState } from '../types/clustering';
import {
  computeClusterAuthTokenHex,
  createInitialTelemetryState,
  parseQrPairingPayload,
  probeMasterEndpointReachable,
  runAutoDiagnosticsSuite,
  runCalibrationBenchmark,
} from '../service/nodeClusterService';

function nowTime(): string {
  return new Date().toTimeString().slice(0, 8);
}

function appendLog(logs: string[], msg: string): string[] {
  return [`[${nowTime()}] ${msg}`, ...logs].slice(0, 40);
}

export function useNodeWorkerStore(developerModeEnabled: boolean) {
  const [telemetry, setTelemetry] = useState<DeviceTelemetryState>(() =>
    createInitialTelemetryState(developerModeEnabled)
  );

  // Sync Developer Mode flag from parent Studio store
  useEffect(() => {
    setTelemetry((prev) => ({ ...prev, developerModeEnabled }));
  }, [developerModeEnabled]);

  const recalibrate = useCallback(() => {
    setTelemetry((prev) => ({
      ...prev,
      calibration: { ...prev.calibration, isCalibrating: true },
    }));

    window.setTimeout(() => {
      setTelemetry((prev) => {
        const { profile, hardware } = runCalibrationBenchmark(
          prev.batteryPercent,
          prev.isPluggedIn,
          prev.temperatureCelsius
        );
        return {
          ...prev,
          totalRamMb: hardware.totalRamMb,
          availableRamMb: hardware.availableRamMb,
          safeCapMb: profile.recommendedSafeRamMb,
          activeBackend: hardware.activeBackend,
          webglProbePassed: hardware.webglSupported,
          webglRendererName: hardware.webglRenderer,
          legacyHardwareMode: hardware.legacyHardware,
          legacyGraphicsMode: hardware.legacyGraphics,
          calibration: profile,
          eventLogs: appendLog(
            prev.eventLogs,
            `Calibrated ${profile.tierLabel} (Score ${profile.performanceScore}/100, ${profile.benchmarkDurationMs}ms)`
          ),
        };
      });
    }, 180);
  }, []);

  // Auto-run initial calibration & Battery Status probe on mount
  useEffect(() => {
    recalibrate();

    const nav = navigator as Navigator & {
      getBattery?: () => Promise<{
        level: number;
        charging: boolean;
        addEventListener?: (evt: string, fn: () => void) => void;
      }>;
    };
    if (typeof nav.getBattery === 'function') {
      nav
        .getBattery()
        .then((battery) => {
          const updateBattery = () => {
            setTelemetry((prev) => ({
              ...prev,
              batteryPercent: Math.round(battery.level * 100),
              isPluggedIn: battery.charging,
            }));
          };
          updateBattery();
          battery.addEventListener?.('levelchange', updateBattery);
          battery.addEventListener?.('chargingchange', updateBattery);
        })
        .catch(() => {
          // Browser battery API unavailable
        });
    }
  }, [recalibrate]);

  const startWorker = useCallback(() => {
    setTelemetry((prev) => {
      const nextState = prev.usbLoopbackOnly ? 'RUNNING_USB' : 'RUNNING_WIFI';
      const bindAddress = prev.usbLoopbackOnly ? '127.0.0.1:50052' : '0.0.0.0:50052';
      return {
        ...prev,
        workerState: nextState,
        bindAddress,
        activeLayersAssigned: Math.min(4, prev.calibration.estimatedLayerCapacity),
        handshakesCompleted: prev.handshakesCompleted + 1,
        eventLogs: appendLog(
          prev.eventLogs,
          `Started worker on ${bindAddress} (${prev.activeBackend}, cap=${prev.safeCapMb} MB)`
        ),
      };
    });
  }, []);

  const stopWorkerAndFreeRam = useCallback(() => {
    setTelemetry((prev) => ({
      ...prev,
      workerState: 'STOPPED',
      activeLayersAssigned: 0,
      eventLogs: appendLog(prev.eventLogs, 'Worker stopped cleanly. All shard memory released.'),
    }));
  }, []);

  const toggleBindMode = useCallback((usbLoopbackOnly: boolean) => {
    setTelemetry((prev) => {
      const bindAddress = usbLoopbackOnly ? '127.0.0.1:50052' : '0.0.0.0:50052';
      const workerState =
        prev.workerState === 'STOPPED'
          ? 'STOPPED'
          : usbLoopbackOnly
            ? 'RUNNING_USB'
            : 'RUNNING_WIFI';
      return {
        ...prev,
        usbLoopbackOnly,
        bindAddress,
        workerState,
        eventLogs: appendLog(
          prev.eventLogs,
          `Switched bind mode to ${usbLoopbackOnly ? 'USB Loopback (127.0.0.1)' : 'Wi-Fi LAN (0.0.0.0)'}`
        ),
      };
    });
  }, []);

  const updateClusterSecret = useCallback((secret: string) => {
    setTelemetry((prev) => ({
      ...prev,
      clusterSecret: secret,
      authTokenHex: computeClusterAuthTokenHex(secret),
      pairingQrPayload: `clusterd://pair?master=${prev.pairedMasterAddress.includes(':') && !prev.pairedMasterAddress.startsWith('Not') ? prev.pairedMasterAddress.split(' ')[0] : '127.0.0.1:8080'}&rpc=50052&secret=${secret}`,
    }));
  }, []);

  const pairQrPayload = useCallback((rawPayload: string) => {
    const parsed = parseQrPairingPayload(rawPayload);
    if (!parsed) return false;
    setTelemetry((prev) => {
      const nextWorkerState = parsed.isUsb ? 'RUNNING_USB' : 'RUNNING_WIFI';
      const bindAddress = parsed.isUsb ? '127.0.0.1:50052' : '0.0.0.0:50052';
      return {
        ...prev,
        pairedMasterAddress: `${parsed.masterAddr} (Paired)`,
        clusterSecret: parsed.secret,
        authTokenHex: computeClusterAuthTokenHex(parsed.secret),
        usbLoopbackOnly: parsed.isUsb,
        bindAddress,
        workerState: nextWorkerState,
        activeLayersAssigned: Math.min(4, prev.calibration.estimatedLayerCapacity),
        handshakesCompleted: prev.handshakesCompleted + 1,
        pairingQrPayload: `clusterd://pair?master=${parsed.masterAddr}&rpc=50052&secret=${parsed.secret}`,
        eventLogs: appendLog(
          prev.eventLogs,
          `Paired with master ${parsed.masterAddr} (${parsed.isUsb ? 'USB Tunnel' : 'Wi-Fi LAN'})`
        ),
      };
    });
    return true;
  }, []);

  const autoDetectMaster = useCallback(async () => {
    setTelemetry((prev) => ({
      ...prev,
      isScanningMaster: true,
      eventLogs: appendLog(prev.eventLogs, 'Scanning for clusterd master on USB localhost (127.0.0.1:8080)...'),
    }));

    const localReachable = await probeMasterEndpointReachable('127.0.0.1:8080');
    setTelemetry((prev) => {
      if (localReachable) {
        return {
          ...prev,
          isScanningMaster: false,
          usbLoopbackOnly: true,
          bindAddress: '127.0.0.1:50052',
          pairedMasterAddress: '127.0.0.1:8080 (Live Master)',
          workerState: 'RUNNING_USB',
          activeLayersAssigned: Math.min(4, prev.calibration.estimatedLayerCapacity),
          handshakesCompleted: prev.handshakesCompleted + 1,
          eventLogs: appendLog(prev.eventLogs, 'Auto-detected live master at 127.0.0.1:8080!'),
        };
      }
      return {
        ...prev,
        isScanningMaster: false,
        eventLogs: appendLog(
          prev.eventLogs,
          'No local master responded on 127.0.0.1:8080. Use Scan QR or start `clusterd` on PC.'
        ),
      };
    });
  }, []);

  const simulateLowMemoryShedLayers = useCallback(() => {
    setTelemetry((prev) => ({
      ...prev,
      workerState: 'SHEDDING_MEMORY',
      activeLayersAssigned: 0,
      lastTrimLevel: 15,
      availableRamMb: Math.max(384, Math.round(prev.totalRamMb * 0.2)),
      eventLogs: appendLog(
        prev.eventLogs,
        'TRIM_MEMORY_RUNNING_CRITICAL (15) -> SHED_LAYERS evicted shards immediately.'
      ),
    }));
  }, []);

  const runDiagnostics = useCallback(async () => {
    setTelemetry((prev) => ({ ...prev, isDiagnosing: true }));
    const report = await runAutoDiagnosticsSuite(telemetry);
    setTelemetry((prev) => ({
      ...prev,
      isDiagnosing: false,
      diagnosticReport: report,
      eventLogs: appendLog(prev.eventLogs, `Diagnostics complete: ${report.headline}`),
    }));
  }, [telemetry]);

  const applyAutoFix = useCallback(
    async (action: AutoFixAction) => {
      switch (action) {
        case 'AUTO_DETECT_MASTER':
          await autoDetectMaster();
          break;
        case 'RECALIBRATE_DEVICE':
          recalibrate();
          break;
        case 'START_SHARING':
          startWorker();
          break;
        case 'SWITCH_TO_USB_SAFE_MODE':
          toggleBindMode(true);
          startWorker();
          break;
        case 'FREE_MEMORY_AND_RESTART':
          setTelemetry((prev) => ({
            ...prev,
            availableRamMb: Math.round(prev.totalRamMb * 0.68),
            lastTrimLevel: 0,
            workerState: prev.usbLoopbackOnly ? 'RUNNING_USB' : 'RUNNING_WIFI',
            eventLogs: appendLog(prev.eventLogs, 'Memory headroom restored and sharing resumed.'),
          }));
          recalibrate();
          break;
      }
      const nextReport = await runAutoDiagnosticsSuite(telemetry);
      setTelemetry((prev) => ({ ...prev, diagnosticReport: nextReport }));
    },
    [autoDetectMaster, recalibrate, startWorker, toggleBindMode, telemetry]
  );

  return {
    telemetry,
    recalibrate,
    startWorker,
    stopWorkerAndFreeRam,
    toggleBindMode,
    updateClusterSecret,
    pairQrPayload,
    autoDetectMaster,
    simulateLowMemoryShedLayers,
    runDiagnostics,
    applyAutoFix,
  };
}
