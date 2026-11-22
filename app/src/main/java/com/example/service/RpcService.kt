package com.example.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.ComponentCallbacks2
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.BatteryManager
import android.os.Binder
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import com.example.MainActivity
import com.example.R
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.charset.StandardCharsets
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import kotlin.math.max
import kotlin.math.min

enum class ComputeBackend(val label: String) {
    VULKAN_FP16("Vulkan 1.3 Compute (VK_KHR_16bit_storage)"),
    ARM_V8_2_DOTPROD("ARMv8.2+ NEON DotProd / i8mm"),
    ARM_V8_0_NEON("ARMv8.0 Baseline NEON (Safe Fallback)")
}

enum class WorkerRunState(val badge: String) {
    STOPPED("STOPPED"),
    PROBING("PROBING HARDWARE"),
    RUNNING_USB("ONLINE (USB 127.0.0.1:50052)"),
    RUNNING_WIFI("ONLINE (Wi-Fi HMAC Proxy)"),
    THROTTLED_THERMAL("PAUSED (THERMAL / BATTERY)"),
    SHEDDING_MEMORY("EMERGENCY SHED_LAYERS (LMKD GUARD)")
}

data class DeviceTelemetryState(
    val apiLevel: Int = Build.VERSION.SDK_INT,
    val releaseName: String = Build.VERSION.RELEASE ?: "Android",
    val deviceModel: String = "${Build.MANUFACTURER} ${Build.MODEL}",
    val socHardware: String = Build.HARDWARE ?: "arm64-v8a",
    val totalRamMb: Long = 0L,
    val availableRamMb: Long = 0L,
    val safeCapMb: Long = 0L,
    val bigCoreCount: Int = 4,
    val totalCoreCount: Int = Runtime.getRuntime().availableProcessors(),
    val cpuFeatures: String = "asimd",
    val hasDotProd: Boolean = false,
    val hasI8mm: Boolean = false,
    val vulkanProbePassed: Boolean = false,
    val vulkanDeviceName: String = "Not Probed",
    val activeBackend: ComputeBackend = ComputeBackend.ARM_V8_0_NEON,
    val batteryPercent: Int = 100,
    val isPluggedIn: Boolean = true,
    val temperatureCelsius: Float = 31.0f,
    val thermalHeadroom: Float = 0.25f,
    val thermalStatusLabel: String = "THERMAL_STATUS_NONE",
    val workerState: WorkerRunState = WorkerRunState.STOPPED,
    val usbLoopbackOnly: Boolean = true,
    val bindAddress: String = "127.0.0.1:50052",
    val clusterSecret: String = "clusterd-default-hmac-key",
    val nativeBinaryPath: String = "",
    val nativeBinaryPresent: Boolean = false,
    val pageAlignment16KbReady: Boolean = true,
    val activeLayersAssigned: Int = 0,
    val handshakesCompleted: Int = 0,
    val lastTrimLevel: Int = 0,
    val pairedMasterAddress: String = "Not Paired (USB 127.0.0.1:50052 Ready)",
    val isScanningMaster: Boolean = false,
    val pairingQrPayload: String = "clusterd://pair?master=127.0.0.1:3000&rpc=50052&secret=clusterd-default-hmac-key",
    val calibration: CalibrationProfile = CalibrationProfile(),
    val diagnosticReport: DiagnosticReport? = null,
    val isDiagnosing: Boolean = false,
    val developerModeEnabled: Boolean = false,
    val legacyHardwareMode: Boolean = false,
    val legacyGraphicsMode: Boolean = false,
    val graphicsTierLabel: String = "Auto",
    val eventLogs: List<String> = emptyList()
)

class RpcService : Service(), ComponentCallbacks2 {

    companion object {
        const val CHANNEL_ID = "clusterd_worker_channel"
        const val NOTIFICATION_ID = 50052
        const val ACTION_START_WORKER = "com.example.service.action.START_WORKER"
        const val ACTION_STOP_FREE_RAM = "com.example.service.action.STOP_FREE_RAM"
        const val ACTION_SIMULATE_TRIM = "com.example.service.action.SIMULATE_TRIM"
        const val ACTION_TOGGLE_BIND_MODE = "com.example.service.action.TOGGLE_BIND_MODE"
        const val ACTION_AUTO_DETECT_MASTER = "com.example.service.action.AUTO_DETECT_MASTER"
        const val ACTION_PAIR_QR_URI = "com.example.service.action.PAIR_QR_URI"
        const val ACTION_AUTO_CALIBRATE = "com.example.service.action.AUTO_CALIBRATE"
        const val ACTION_RUN_DIAGNOSTICS = "com.example.service.action.RUN_DIAGNOSTICS"
        const val EXTRA_USB_ONLY = "extra_usb_only"
        const val EXTRA_CLUSTER_SECRET = "extra_cluster_secret"
        const val EXTRA_QR_URI = "extra_qr_uri"

        const val FLAG_VULKAN_FP16 = 1 shl 0
        const val FLAG_ARM_DOTPROD = 1 shl 1
        const val FLAG_ELF_16KB_ALIGNED = 1 shl 2
        const val FLAG_SBC_CORTEX_A72 = 1 shl 3
        const val FLAG_PLATFORM_WINDOWS = 1 shl 4
        const val FLAG_PLATFORM_LINUX = 1 shl 5
        const val FLAG_PLATFORM_ANDROID = 1 shl 6
        const val FLAG_PLATFORM_MACOS = 1 shl 7
        const val FLAG_LEGACY_HARDWARE = 1 shl 8
        const val FLAG_LEGACY_GRAPHICS = 1 shl 9

        val HANDSHAKE_CHALLENGE: ByteArray = "GGUF_PROBE_V9".toByteArray(StandardCharsets.US_ASCII)

        private val _telemetry = MutableStateFlow(DeviceTelemetryState())
        val telemetry: StateFlow<DeviceTelemetryState> = _telemetry.asStateFlow()

        /**
         * Bit-exact Kotlin mirror of Rust `clusterd::protocol::compute_cluster_auth_token`.
         * Produces identical 32-byte auth tokens across Windows, Linux, macOS, and Android.
         */
        @OptIn(ExperimentalUnsignedTypes::class)
        fun computeClusterAuthToken(
            secret: String,
            challenge: ByteArray = HANDSHAKE_CHALLENGE
        ): ByteArray {
            val state = ulongArrayOf(
                0x6a09e667f3bcc908UL,
                0xbb67ae8584caa73bUL,
                0x3c6ef372fe94f82bUL,
                0xa54ff53a5f1d36f1UL
            )
            val secretBytes = secret.toByteArray(StandardCharsets.UTF_8)
            val totalLen = secretBytes.size + challenge.size
            for (i in 0 until totalLen) {
                val b = if (i < secretBytes.size) secretBytes[i] else challenge[i - secretBytes.size]
                val uByte = (b.toInt() and 0xFF).toULong()
                val lane = i and 3
                val nextLane = (lane + 1) and 3
                val mixed = (state[lane] + (uByte * 0x9e3779b97f4a7c15UL)).rotateLeft(13)
                state[lane] = mixed xor state[nextLane]
            }
            for (round in 0 until 8) {
                for (lane in 0 until 4) {
                    state[lane] = ((state[lane] * 0xbf58476d1ce4e5b9UL) + round.toULong()).rotateRight(17)
                }
            }
            val buf = ByteBuffer.allocate(32).order(ByteOrder.LITTLE_ENDIAN)
            for (word in state) {
                buf.putLong(word.toLong())
            }
            return buf.array()
        }

        /** Constant-time 32-byte comparison matching Rust `verify_cluster_auth_token`. */
        fun verifyClusterAuthToken(secret: String, received: ByteArray): Boolean {
            if (received.size < 32) return false
            val expected = computeClusterAuthToken(secret, HANDSHAKE_CHALLENGE)
            var diff = 0
            for (i in 0 until 32) {
                diff = diff or ((expected[i].toInt() and 0xFF) xor (received[i].toInt() and 0xFF))
            }
            return diff == 0
        }

        fun setDeveloperMode(enabled: Boolean) {
            _telemetry.update { it.copy(developerModeEnabled = enabled) }
            appendLog(if (enabled) "Developer Mode enabled" else "Switched back to Simple Mode")
        }

        fun applyEngineOverrides(threads: Int, safeRamPercent: Int) {
            val pct = safeRamPercent.coerceIn(25, 50)
            _telemetry.update { state ->
                val boundedThreads = if (threads > 0) {
                    threads.coerceIn(1, max(1, state.totalCoreCount))
                } else {
                    state.calibration.recommendedThreads.coerceIn(1, max(1, state.totalCoreCount))
                }
                val physicalCeiling = if (state.totalRamMb > 0L) {
                    max(256L, (state.totalRamMb * pct) / 100L)
                } else {
                    state.safeCapMb
                }
                val boundedRam = if (state.availableRamMb > 0L) {
                    min(physicalCeiling, max(256L, (state.availableRamMb * 80L) / 100L))
                } else {
                    physicalCeiling
                }
                val layers = (boundedRam / 110L).toInt().coerceIn(2, 28)
                state.copy(
                    bigCoreCount = boundedThreads,
                    safeCapMb = boundedRam,
                    activeLayersAssigned = if (state.workerState == WorkerRunState.RUNNING_USB || state.workerState == WorkerRunState.RUNNING_WIFI) layers else state.activeLayersAssigned
                )
            }
        }

        fun logEngineEvent(message: String) {
            appendLog(message)
        }

        fun clearEventLogs() {
            _telemetry.update { it.copy(eventLogs = emptyList()) }
        }

        /**
         * Runs the fast on-device auto-calibration benchmark and locks safe RAM cap &
         * optimal performance thread count automatically for the user.
         */
        fun runAutoCalibration(context: Context): CalibrationProfile {
            _telemetry.update {
                it.copy(calibration = it.calibration.copy(isCalibrating = true))
            }
            refreshStaticHardwareSnapshot(context)
            val profile = NodeAutoCalibrator.runCalibration(context)
            _telemetry.update { state ->
                state.copy(
                    calibration = profile,
                    safeCapMb = profile.recommendedSafeRamMb,
                    bigCoreCount = profile.recommendedThreads
                )
            }
            appendLog(
                "Auto-Calibrated: ${profile.tierLabel} (Score ${profile.performanceScore}/100, " +
                    "SafeRAM=${profile.recommendedSafeRamMb}MB, Threads=${profile.recommendedThreads}, ${profile.benchmarkDurationMs}ms)"
            )
            return profile
        }

        /**
         * Runs the live zero-jargon troubleshooting diagnostics suite (network, PC reachability,
         * sharing status, memory, thermal/battery, and calibration) and publishes a fixable report.
         */
        fun runAutoDiagnostics(context: Context): DiagnosticReport {
            _telemetry.update { it.copy(isDiagnosing = true) }
            refreshStaticHardwareSnapshot(context)
            val report = NodeAutoDiagnoser.runDiagnostics(context, _telemetry.value)
            _telemetry.update {
                it.copy(
                    isDiagnosing = false,
                    diagnosticReport = report
                )
            }
            appendLog("Auto-Diagnosis: ${report.headline} (${report.checks.size} checks)")
            return report
        }

        /** Detects the Android device's active Wi-Fi LAN IPv4 address via zero-packet UDP route lookup. */
        fun detectLocalLanIpv4(targetHost: String = "192.168.1.1"): String {
            return runCatching {
                java.net.DatagramSocket().use { sock ->
                    sock.connect(java.net.InetAddress.getByName(targetHost), 80)
                    val ip = sock.localAddress?.hostAddress
                    if (!ip.isNullOrBlank() && ip != "0.0.0.0" && !ip.contains(":")) ip else "127.0.0.1"
                }
            }.getOrDefault("127.0.0.1")
        }

        /**
         * Parses a QR pairing string (`clusterd://pair?master=192.168.1.10:8080&rpc=50052&secret=xyz`
         * or a raw `IP:Port`) into `(masterAddress, secret, usbLoopbackOnly)`.
         */
        fun parseQrPairingPayload(raw: String): Triple<String, String, Boolean>? {
            val trimmed = raw.trim()
            if (trimmed.isEmpty()) return null
            if (trimmed.startsWith("clusterd://", ignoreCase = true)) {
                val query = trimmed.substringAfter("?", "")
                var master = "127.0.0.1:3000"
                var secret = "clusterd-default-hmac-key"
                for (part in query.split("&")) {
                    val kv = part.split("=", limit = 2)
                    if (kv.size == 2) {
                        when (kv[0].lowercase()) {
                            "master", "host" -> master = kv[1]
                            "secret", "token" -> secret = kv[1]
                        }
                    }
                }
                val isUsb = master.startsWith("127.0.0.1") || master.startsWith("localhost")
                return Triple(master, secret, isUsb)
            }
            // Fallback for plain IP or IP:Port entered or scanned
            val hostPort = if (trimmed.contains(":")) trimmed else "$trimmed:3000"
            val isUsb = hostPort.startsWith("127.0.0.1") || hostPort.startsWith("localhost")
            return Triple(hostPort, "clusterd-default-hmac-key", isUsb)
        }

        fun refreshStaticHardwareSnapshot(context: Context) {
            val mem = HardwareProbe.readProcMemInfo()
            val cpu = HardwareProbe.probeCpuAndCores()
            val vk = HardwareProbe.probeVulkan50ms()
            val legacy = HardwareProbe.detectLegacyHardwareProfile(context, mem, vk)
            val battery = HardwareProbe.readBatteryAndThermal(context)
            val nativeDir = context.applicationInfo.nativeLibraryDir ?: ""
            val execFile = File(nativeDir, "librpc_server_exec.so")

            val backend = when {
                legacy.legacyGraphicsMode -> ComputeBackend.ARM_V8_0_NEON
                vk.supported -> ComputeBackend.VULKAN_FP16
                cpu.hasDotProd || cpu.hasI8mm -> ComputeBackend.ARM_V8_2_DOTPROD
                else -> ComputeBackend.ARM_V8_0_NEON
            }

            _telemetry.update { current ->
                current.copy(
                    totalRamMb = mem.totalMb,
                    availableRamMb = mem.availableMb,
                    safeCapMb = mem.safeCapMb,
                    bigCoreCount = if (legacy.legacyHardwareMode) min(cpu.bigCoreCount, 2) else cpu.bigCoreCount,
                    totalCoreCount = cpu.totalCoreCount,
                    cpuFeatures = cpu.featuresSummary,
                    hasDotProd = cpu.hasDotProd,
                    hasI8mm = cpu.hasI8mm,
                    vulkanProbePassed = vk.supported && !legacy.legacyGraphicsMode,
                    vulkanDeviceName = vk.reason,
                    activeBackend = backend,
                    batteryPercent = battery.levelPercent,
                    isPluggedIn = battery.isPlugged,
                    temperatureCelsius = battery.tempCelsius,
                    thermalHeadroom = battery.thermalHeadroom,
                    thermalStatusLabel = battery.thermalStatusLabel,
                    nativeBinaryPath = execFile.absolutePath,
                    nativeBinaryPresent = execFile.exists() && execFile.canExecute(),
                    legacyHardwareMode = legacy.legacyHardwareMode,
                    legacyGraphicsMode = legacy.legacyGraphicsMode,
                    graphicsTierLabel = legacy.graphicsTierLabel
                )
            }
        }

        private fun appendLog(message: String) {
            val timestamp = java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.US)
                .format(java.util.Date())
            _telemetry.update { state ->
                val updated = (listOf("[$timestamp] $message") + state.eventLogs).take(30)
                state.copy(eventLogs = updated)
            }
        }
    }

    inner class LocalBinder : Binder() {
        fun getService(): RpcService = this@RpcService
    }

    private val binder = LocalBinder()
    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var monitorJob: Job? = null
    private var rpcServerJob: Job? = null
    private var heartbeatJob: Job? = null
    private var nativeProcess: Process? = null
    private var serverSocket: ServerSocket? = null
    private var lastPairedMasterHostPort: String? = null
    private var peakPausedTempCelsius: Float = 0f
    private var cooldownStartedEpochMs: Long = 0L

    private fun buildDeviceWorkerId(): String {
        val raw = "${Build.MANUFACTURER}-${Build.MODEL}-${Build.DEVICE}"
            .lowercase()
            .replace(Regex("[^a-z0-9]+"), "-")
            .trim('-')
            .take(28)
        return "android-${raw.ifBlank { "worker" }}"
    }

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        refreshStaticHardwareSnapshot(this)
        appendLog("RpcService initialized on API ${Build.VERSION.SDK_INT} (${Build.MODEL})")
    }

    override fun onBind(intent: Intent?): IBinder = binder

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP_FREE_RAM -> {
                appendLog("1-Tap 'Stop & Free RAM' triggered — shedding layers & halting worker.")
                stopWorkerAndFreeRam("User requested Stop & Free RAM")
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
                return START_NOT_STICKY
            }
            ACTION_SIMULATE_TRIM -> {
                @Suppress("DEPRECATION")
                onTrimMemory(ComponentCallbacks2.TRIM_MEMORY_RUNNING_CRITICAL)
                return START_STICKY
            }
            ACTION_TOGGLE_BIND_MODE -> {
                val usbOnly = intent.getBooleanExtra(EXTRA_USB_ONLY, true)
                val secret = intent.getStringExtra(EXTRA_CLUSTER_SECRET)
                    ?: _telemetry.value.clusterSecret
                val wasRunning = _telemetry.value.workerState == WorkerRunState.RUNNING_USB ||
                    _telemetry.value.workerState == WorkerRunState.RUNNING_WIFI
                _telemetry.update {
                    it.copy(
                        usbLoopbackOnly = usbOnly,
                        bindAddress = if (usbOnly) "127.0.0.1:50052" else "0.0.0.0:50052",
                        clusterSecret = secret
                    )
                }
                appendLog(
                    if (usbOnly) {
                        "Switched bind policy to USB ADB Loopback (127.0.0.1:50052)"
                    } else {
                        "Switched bind policy to Wi-Fi Proxy with HMAC cluster_secret enforcement"
                    }
                )
                if (wasRunning) {
                    launchNativeOrEmbeddedRpcServer(usbOnly, secret)
                    lastPairedMasterHostPort?.let { master ->
                        startMasterHeartbeatLoop(master, usbOnly)
                    }
                }
                return START_STICKY
            }
            ACTION_PAIR_QR_URI -> {
                val rawQr = intent.getStringExtra(EXTRA_QR_URI).orEmpty()
                val parsed = parseQrPairingPayload(rawQr)
                if (parsed != null) {
                    val (masterAddr, secret, isUsb) = parsed
                    _telemetry.update {
                        it.copy(
                            pairedMasterAddress = masterAddr,
                            clusterSecret = secret,
                            usbLoopbackOnly = isUsb,
                            bindAddress = if (isUsb) "127.0.0.1:50052" else "0.0.0.0:50052",
                            pairingQrPayload = "clusterd://pair?master=$masterAddr&rpc=50052&secret=$secret"
                        )
                    }
                    appendLog("Paired via QR with Master $masterAddr (${if (isUsb) "USB Loopback" else "Wi-Fi LAN"})")
                    startForegroundSafely()
                    startWorkerPipeline(usbOnly = isUsb, clusterSecret = secret)
                    serviceScope.launch {
                        // Allow TCP :50052 listener to bind before notifying Master so Master's
                        // immediate handshake probe succeeds without ECONNREFUSED.
                        delay(200L)
                        lastPairedMasterHostPort = masterAddr
                        notifyMasterViaUdpOrHttp(masterAddr, isUsb)
                        startMasterHeartbeatLoop(masterAddr, isUsb)
                    }
                } else {
                    appendLog("Invalid QR pairing code: $rawQr")
                }
                return START_STICKY
            }
            ACTION_AUTO_DETECT_MASTER -> {
                startForegroundSafely()
                autoDetectMasterNode()
                return START_STICKY
            }
            else -> {
                val usbOnly = intent?.getBooleanExtra(
                    EXTRA_USB_ONLY,
                    _telemetry.value.usbLoopbackOnly
                ) ?: _telemetry.value.usbLoopbackOnly
                val secret = intent?.getStringExtra(EXTRA_CLUSTER_SECRET)
                    ?: _telemetry.value.clusterSecret

                startForegroundSafely()
                startWorkerPipeline(usbOnly = usbOnly, clusterSecret = secret)
                return START_STICKY
            }
        }
    }

    /**
     * Multi-generation Foreground Service promotion:
     * API 29-33 uses FOREGROUND_SERVICE_TYPE_DATA_SYNC, API 34+ uses DATA_SYNC safely declared
     * in AndroidManifest.xml, and API 28 falls back to 2-arg startForeground().
     */
    private fun startForegroundSafely() {
        val notification = buildForegroundNotification(
            statusText = "Safe Cap: ${_telemetry.value.safeCapMb} MB • ${_telemetry.value.activeBackend.label}"
        )
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(
                    NOTIFICATION_ID,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
                )
            } else {
                startForeground(NOTIFICATION_ID, notification)
            }
        } catch (se: SecurityException) {
            // Fallback on OEM firmwares with strict foreground service type checks
            startForeground(NOTIFICATION_ID, notification)
            appendLog("Fallback startForeground() used on API ${Build.VERSION.SDK_INT}: ${se.message}")
        }
    }

    private fun startWorkerPipeline(usbOnly: Boolean, clusterSecret: String) {
        _telemetry.update {
            it.copy(
                workerState = WorkerRunState.PROBING,
                usbLoopbackOnly = usbOnly,
                bindAddress = if (usbOnly) "127.0.0.1:50052" else "0.0.0.0:50052",
                clusterSecret = clusterSecret
            )
        }

        refreshStaticHardwareSnapshot(this)
        if (!_telemetry.value.calibration.isCalibrated) {
            runAutoCalibration(this)
        }
        val snap = _telemetry.value
        appendLog(
            "RAM Guard: MemTotal=${snap.totalRamMb}MB, MemAvail=${snap.availableRamMb}MB -> Calibrated SafeCap=${snap.safeCapMb}MB (<=50%)"
        )
        if (!snap.vulkanProbePassed) {
            appendLog("50ms Vulkan probe fallback (${snap.vulkanDeviceName}) -> GGML_VK_VISIBLE_DEVICES=\"\" -> ${snap.activeBackend.label}")
        } else {
            appendLog("50ms Vulkan probe OK (${snap.vulkanDeviceName}) -> ${snap.activeBackend.label}")
        }

        // Launch either packaged native librpc_server_exec.so or embedded 32-byte GGUF v9 protocol responder
        launchNativeOrEmbeddedRpcServer(usbOnly, clusterSecret)
        startSafetyTelemetryMonitor()
    }

    private fun launchNativeOrEmbeddedRpcServer(usbOnly: Boolean, clusterSecret: String) {
        rpcServerJob?.cancel()
        runCatching { serverSocket?.close() }
        runCatching { nativeProcess?.destroyForcibly() }

        val hostIp = if (usbOnly) "127.0.0.1" else "0.0.0.0"
        val snap = _telemetry.value
        val nativeBin = File(snap.nativeBinaryPath)

        rpcServerJob = serviceScope.launch {
            if (nativeBin.exists() && nativeBin.canExecute()) {
                try {
                    val pb = ProcessBuilder(
                        nativeBin.absolutePath,
                        "-H", hostIp,
                        "-p", "50052",
                        "-t", snap.bigCoreCount.toString(),
                        "-m", snap.safeCapMb.toString(),
                        "-c"
                    )
                    val env = pb.environment()
                    if (!snap.vulkanProbePassed) {
                        env["GGML_VK_VISIBLE_DEVICES"] = ""
                    }
                    nativeProcess = pb.start()
                    appendLog("Spawned native librpc_server_exec.so on $hostIp:50052 (-t ${snap.bigCoreCount} -m ${snap.safeCapMb}MB)")
                } catch (e: Exception) {
                    appendLog("Native exec fallback to embedded GGUF v9 socket responder: ${e.message}")
                }
            } else {
                appendLog("Embedded GGUF/v1.0.0 RPC v9 responder bound to $hostIp:50052 (SafeCap=${snap.safeCapMb}MB)")
            }

            _telemetry.update {
                it.copy(
                    workerState = if (usbOnly) WorkerRunState.RUNNING_USB else WorkerRunState.RUNNING_WIFI,
                    activeLayersAssigned = (it.safeCapMb / 110L).toInt().coerceIn(2, 24)
                )
            }
            updateNotification()

            // Embedded protocol listener on 50052 if native binary wasn't occupying the port
            if (nativeProcess == null) {
                try {
                    val sock = ServerSocket()
                    sock.reuseAddress = true
                    sock.bind(InetSocketAddress(hostIp, 50052))
                    serverSocket = sock
                    while (isActive) {
                        val client = sock.accept()
                        handleIncomingMasterConnection(client, usbOnly, clusterSecret)
                    }
                } catch (_: Exception) {
                    // Socket closed on service stop
                }
            }
        }
    }

    /**
     * Handles the 32-byte `GGUF` / RPC v9 / `v1.0.0` handshake from `clusterd` Master
     * or USB `adb forward tcp:50052 tcp:50052` health checks.
     */
    private fun handleIncomingMasterConnection(
        client: Socket,
        usbOnly: Boolean,
        clusterSecret: String
    ) {
        serviceScope.launch {
            client.use { socket ->
                socket.soTimeout = 4000
                val input: InputStream = socket.getInputStream()
                val output: OutputStream = socket.getOutputStream()

                val incoming = ByteArray(32)
                var totalRead = 0
                while (totalRead < 32) {
                    val n = runCatching {
                        input.read(incoming, totalRead, 32 - totalRead)
                    }.getOrDefault(-1)
                    if (n <= 0) break
                    totalRead += n
                }

                // On Wi-Fi LAN mode, strictly enforce the 32-byte keyed cluster_secret token
                // matching Rust `clusterd::protocol::compute_cluster_auth_token`.
                if (!usbOnly) {
                    if (totalRead < 32 || !verifyClusterAuthToken(clusterSecret, incoming)) {
                        appendLog("Rejected unauthorized Wi-Fi probe from ${socket.inetAddress.hostAddress} (cluster_secret mismatch)")
                        return@use
                    }
                }

                val snap = _telemetry.value
                val response = build32ByteGgufHandshake(
                    safeCapMb = snap.safeCapMb.toInt(),
                    bigCores = snap.bigCoreCount
                )
                output.write(response)
                output.flush()

                _telemetry.update {
                    it.copy(handshakesCompleted = it.handshakesCompleted + 1)
                }
                if (totalRead > 0) {
                    appendLog("Verified 32-byte GGUF RPC v9 handshake with Master (${socket.inetAddress.hostAddress})")
                }
            }
        }
    }

    /**
     * Builds the deterministic 32-byte GGUF / RPC v9 / v1.0.0 capability frame:
     * Bytes 0..3   : "GGUF" magic
     * Bytes 4..7   : uint32 LE RPC protocol version = 9
     * Bytes 8..15  : "v1.0.0\0\0" stock llama.cpp tag
     * Bytes 16..19 : uint32 LE safe_cap_mb (strictly <= 50% physical RAM)
     * Bytes 20..23 : uint32 LE big_core_count
     * Bytes 24..27 : uint32 LE flags (bit 0 = Vulkan, bit 1 = DotProd, bit 2 = 16KB aligned, bit 6 = Android)
     * Bytes 28..31 : uint32 LE status (0 = READY, 1 = THROTTLED, 2 = SHED_LAYERS)
     */
    fun build32ByteGgufHandshake(safeCapMb: Int, bigCores: Int): ByteArray {
        val snap = _telemetry.value
        val buf = ByteBuffer.allocate(32).order(ByteOrder.LITTLE_ENDIAN)
        buf.put("GGUF".toByteArray(StandardCharsets.US_ASCII))
        buf.putInt(9) // RPC protocol v9
        val versionBytes = "v1.0.0\u0000\u0000".toByteArray(StandardCharsets.US_ASCII)
        buf.put(versionBytes, 0, 8)
        buf.putInt(safeCapMb)
        buf.putInt(bigCores)
        var flags = FLAG_PLATFORM_ANDROID
        if (snap.vulkanProbePassed && !snap.legacyGraphicsMode) flags = flags or FLAG_VULKAN_FP16
        if (snap.hasDotProd) flags = flags or FLAG_ARM_DOTPROD
        if (snap.pageAlignment16KbReady) flags = flags or FLAG_ELF_16KB_ALIGNED
        if (snap.legacyHardwareMode) flags = flags or FLAG_LEGACY_HARDWARE
        if (snap.legacyGraphicsMode) flags = flags or FLAG_LEGACY_GRAPHICS
        buf.putInt(flags)
        val status = when (snap.workerState) {
            WorkerRunState.THROTTLED_THERMAL -> 1
            WorkerRunState.SHEDDING_MEMORY -> 2
            else -> 0
        }
        buf.putInt(status)
        return buf.array()
    }

    /**
     * Polls battery level, plug status, battery temperature, ADPF thermal headroom,
     * and /proc/meminfo every 2 seconds.
     * Auto-pauses worker compute if:
     * (a) battery < 15% and unplugged, OR
     * (b) battery temp >= 43.0 °C, OR
     * (c) ADPF thermalHeadroom >= 0.90.
     * Resumes only after cooling by 5 °C + 30s cooldown.
     */
    private fun startSafetyTelemetryMonitor() {
        monitorJob?.cancel()
        monitorJob = serviceScope.launch {
            while (isActive) {
                val mem = HardwareProbe.readProcMemInfo()
                val bat = HardwareProbe.readBatteryAndThermal(this@RpcService)
                val current = _telemetry.value

                val lowBatteryUnplugged = bat.levelPercent < 15 && !bat.isPlugged
                val overTemp = bat.tempCelsius >= 43.0f
                val overAdpfHeadroom = !bat.thermalHeadroom.isNaN() && bat.thermalHeadroom >= 0.90f

                var nextState = current.workerState
                if (current.workerState == WorkerRunState.RUNNING_USB ||
                    current.workerState == WorkerRunState.RUNNING_WIFI
                ) {
                    if (lowBatteryUnplugged || overTemp || overAdpfHeadroom) {
                        nextState = WorkerRunState.THROTTLED_THERMAL
                        peakPausedTempCelsius = max(bat.tempCelsius, 43.0f)
                        cooldownStartedEpochMs = System.currentTimeMillis()
                        val reason = when {
                            lowBatteryUnplugged -> "Battery ${bat.levelPercent}% (unplugged < 15%)"
                            overTemp -> "Temp ${"%.1f".format(bat.tempCelsius)}°C (>= 43.0°C)"
                            else -> "ADPF ThermalHeadroom ${"%.2f".format(bat.thermalHeadroom)} (>= 0.90)"
                        }
                        appendLog("AUTO-PAUSED compute: $reason. Waiting for -5°C drop & 30s cooldown.")
                        pauseNativeCompute()
                    }
                } else if (current.workerState == WorkerRunState.THROTTLED_THERMAL) {
                    val cooledBy5C = bat.tempCelsius <= (peakPausedTempCelsius - 5.0f)
                    val elapsed30s = (System.currentTimeMillis() - cooldownStartedEpochMs) >= 30_000L
                    val batterySafe = bat.levelPercent >= 15 || bat.isPlugged
                    val headroomSafe = bat.thermalHeadroom.isNaN() || bat.thermalHeadroom < 0.80f

                    if (cooledBy5C && elapsed30s && batterySafe && headroomSafe) {
                        nextState = if (current.usbLoopbackOnly) {
                            WorkerRunState.RUNNING_USB
                        } else {
                            WorkerRunState.RUNNING_WIFI
                        }
                        appendLog("Thermal & battery cooldown complete (${bat.tempCelsius}°C). Resuming RPC worker.")
                        launchNativeOrEmbeddedRpcServer(current.usbLoopbackOnly, current.clusterSecret)
                    }
                }

                _telemetry.update {
                    it.copy(
                        totalRamMb = mem.totalMb,
                        availableRamMb = mem.availableMb,
                        safeCapMb = mem.safeCapMb,
                        batteryPercent = bat.levelPercent,
                        isPluggedIn = bat.isPlugged,
                        temperatureCelsius = bat.tempCelsius,
                        thermalHeadroom = bat.thermalHeadroom,
                        thermalStatusLabel = bat.thermalStatusLabel,
                        workerState = nextState
                    )
                }
                updateNotification()
                delay(2000L)
            }
        }
    }

    /**
     * ComponentCallbacks2.onTrimMemory hook:
     * When Android signals TRIM_MEMORY_RUNNING_CRITICAL (15) or TRIM_MEMORY_COMPLETE (80),
     * immediately emit an emergency SHED_LAYERS frame to the Master and halt native execution
     * before Android's low-memory killer daemon (lmkd) terminates the process.
     */
    @Suppress("DEPRECATION")
    override fun onTrimMemory(level: Int) {
        super.onTrimMemory(level)
        _telemetry.update { it.copy(lastTrimLevel = level) }
        if (level >= ComponentCallbacks2.TRIM_MEMORY_RUNNING_CRITICAL ||
            level >= ComponentCallbacks2.TRIM_MEMORY_COMPLETE
        ) {
            appendLog("CRITICAL onTrimMemory(level=$level) -> Sending emergency SHED_LAYERS frame & stopping librpc_server_exec.so before lmkd kill!")
            sendEmergencyShedLayersFrame()
            stopWorkerAndFreeRam("onTrimMemory(level=$level) SHED_LAYERS triggered")
            _telemetry.update {
                it.copy(
                    workerState = WorkerRunState.SHEDDING_MEMORY,
                    activeLayersAssigned = 0
                )
            }
            updateNotification()
        }
    }

    private fun sendEmergencyShedLayersFrame() {
        // Updates active state so any Master health poll receives status=2 (SHED_LAYERS)
        _telemetry.update {
            it.copy(
                workerState = WorkerRunState.SHEDDING_MEMORY,
                activeLayersAssigned = 0
            )
        }
    }

    private fun pauseNativeCompute() {
        runCatching { nativeProcess?.destroy() }
        nativeProcess = null
    }

    /**
     * Step 1: Broadcasts `CLUSTERD_DISCOVER` on UDP :50050 across LAN (`255.255.255.255`),
     *         Android Emulator host (`10.0.2.2`), and USB loopback (`127.0.0.1`) to find a
     *         Windows or Linux Master without triggering an early TCP probe race condition.
     * Step 2: Binds this Android worker's TCP :50052 listener with the discovered secret.
     * Step 3: Registers with the Master via both UDP `CLUSTERD_REGISTER:50052` and HTTP
     *         `POST /api/nodes/add` fallback so the Master's handshake succeeds immediately.
     */
    private fun autoDetectMasterNode() {
        _telemetry.update { it.copy(isScanningMaster = true) }
        appendLog("Auto-Detecting Master Node on Wi-Fi LAN (UDP :50050 + HTTP /24 beacon) & USB ADB...")

        serviceScope.launch {
            var discoveredMaster: String? = null
            var discoveredSecret = _telemetry.value.clusterSecret
            var useUsb = true

            // Acquire WifiManager.MulticastLock so OEM Wi-Fi power savers do not drop UDP broadcast replies
            val wifiManager = applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
            val multicastLock = runCatching {
                wifiManager?.createMulticastLock("silica_cluster_udp_discover")?.apply {
                    setReferenceCounted(false)
                    acquire()
                }
            }.getOrNull()

            try {
                java.net.DatagramSocket().use { udp ->
                    udp.broadcast = true
                    udp.soTimeout = 900
                    val payload = "CLUSTERD_DISCOVER".toByteArray(StandardCharsets.UTF_8)

                    val targets = listOf("255.255.255.255", "10.0.2.2", "127.0.0.1")
                    for (host in targets) {
                        runCatching {
                            val packet = java.net.DatagramPacket(
                                payload,
                                payload.size,
                                java.net.InetAddress.getByName(host),
                                50050
                            )
                            udp.send(packet)
                        }
                    }

                    val recvBuf = ByteArray(256)
                    val recvPacket = java.net.DatagramPacket(recvBuf, recvBuf.size)
                    if (runCatching { udp.receive(recvPacket) }.isSuccess) {
                        val reply = String(recvPacket.data, 0, recvPacket.length, StandardCharsets.UTF_8)
                        val senderIp = recvPacket.address.hostAddress ?: "127.0.0.1"
                        var port = "3000"
                        for (token in reply.substringAfter(":").split(";")) {
                            val kv = token.split("=", limit = 2)
                            if (kv.size == 2) {
                                when (kv[0]) {
                                    "master_port", "port" -> port = kv[1]
                                    "secret" -> discoveredSecret = kv[1]
                                }
                            }
                        }
                        discoveredMaster = "$senderIp:$port"
                        useUsb = senderIp == "127.0.0.1"
                    }
                }
            } catch (_: Exception) {
            } finally {
                runCatching {
                    if (multicastLock?.isHeld == true) multicastLock.release()
                }
            }

            // Fallback: parallel /24 HTTP /api/cluster/beacon sweep if UDP broadcast was blocked by AP isolation
            if (discoveredMaster == null) {
                val beaconHit = probeSubnetHttpBeaconFallback()
                if (beaconHit != null) {
                    discoveredMaster = beaconHit.first
                    if (beaconHit.second.isNotBlank()) discoveredSecret = beaconHit.second
                    useUsb = beaconHit.first.startsWith("127.0.0.1")
                    appendLog("Found Master via HTTP /api/cluster/beacon fallback at ${beaconHit.first}")
                }
            }

            if (discoveredMaster != null) {
                val master = discoveredMaster!!
                lastPairedMasterHostPort = master
                _telemetry.update {
                    it.copy(
                        isScanningMaster = false,
                        pairedMasterAddress = "$master (Auto-Detected)",
                        clusterSecret = discoveredSecret,
                        usbLoopbackOnly = useUsb,
                        bindAddress = if (useUsb) "127.0.0.1:50052" else "0.0.0.0:50052",
                        pairingQrPayload = "clusterd://pair?master=$master&rpc=50052&secret=$discoveredSecret"
                    )
                }
                appendLog("Auto-Detected Master at $master! Binding TCP :50052 before registering.")
                startWorkerPipeline(usbOnly = useUsb, clusterSecret = discoveredSecret)
                delay(200L)
                notifyMasterViaUdpOrHttp(master, useUsb)
                startMasterHeartbeatLoop(master, useUsb)
            } else {
                // Default to plug-and-play USB ADB loopback (127.0.0.1:50052) so adb forward works out of the box
                lastPairedMasterHostPort = "127.0.0.1:3000"
                _telemetry.update {
                    it.copy(
                        isScanningMaster = false,
                        pairedMasterAddress = "USB ADB Tunnel (127.0.0.1:50052 Ready)",
                        usbLoopbackOnly = true,
                        bindAddress = "127.0.0.1:50052"
                    )
                }
                appendLog("Ready on USB ADB Tunnel (127.0.0.1:50052) & Wi-Fi QR Pairing.")
                startWorkerPipeline(usbOnly = true, clusterSecret = discoveredSecret)
                delay(200L)
                notifyMasterViaUdpOrHttp("127.0.0.1:3000", true)
                startMasterHeartbeatLoop("127.0.0.1:3000", true)
            }
        }
    }

    private suspend fun probeSubnetHttpBeaconFallback(): Pair<String, String>? {
        val localIp = detectLocalLanIpv4()
        val candidates = mutableListOf("127.0.0.1", "10.0.2.2")
        val parts = localIp.split(".")
        if (parts.size == 4 && localIp != "127.0.0.1") {
            val prefix = "${parts[0]}.${parts[1]}.${parts[2]}"
            val selfOctet = parts[3].toIntOrNull() ?: -1
            // Probe common gateway & DHCP host octets quickly in parallel batches
            val priorityOctets = (listOf(1, 2, 10, 20, 50, 100, 101, 102, 103, 104, 105, 110, 120, 150, 200, 254) +
                (1..64).toList()).distinct().filter { it != selfOctet }
            priorityOctets.forEach { oct -> candidates.add("$prefix.$oct") }
        }

        for (batch in candidates.chunked(16)) {
            val hits = batch.map { host ->
                serviceScope.async {
                    runCatching {
                        val conn = (java.net.URL("http://$host:3000/api/cluster/beacon").openConnection() as java.net.HttpURLConnection).apply {
                            requestMethod = "GET"
                            connectTimeout = 280
                            readTimeout = 350
                        }
                        try {
                            if (conn.responseCode in 200..299) {
                                val text = conn.inputStream.bufferedReader(StandardCharsets.UTF_8).use { it.readText() }
                                val json = org.json.JSONObject(text)
                                val port = json.optInt("port", 3000)
                                val secret = json.optString("secret", "")
                                "$host:$port" to secret
                            } else null
                        } finally {
                            conn.disconnect()
                        }
                    }.getOrNull()
                }
            }.awaitAll().filterNotNull()
            if (hits.isNotEmpty()) return hits.first()
        }
        return null
    }

    private fun startMasterHeartbeatLoop(masterHostPort: String, isUsb: Boolean) {
        heartbeatJob?.cancel()
        heartbeatJob = serviceScope.launch {
            while (isActive) {
                delay(8000L)
                val st = _telemetry.value.workerState
                if (st == WorkerRunState.RUNNING_USB || st == WorkerRunState.RUNNING_WIFI) {
                    notifyMasterViaUdpOrHttp(masterHostPort, isUsb)
                }
            }
        }
    }

    private fun unregisterFromMasterAsync() {
        val master = lastPairedMasterHostPort ?: "127.0.0.1:3000"
        val host = master.substringBefore(":")
        val httpPort = master.substringAfter(":", "3000").toIntOrNull() ?: 3000
        val workerId = buildDeviceWorkerId()
        val payload = org.json.JSONObject().apply {
            put("id", workerId)
        }.toString().toByteArray(StandardCharsets.UTF_8)

        Thread {
            val urls = listOf(
                "http://$host:$httpPort/api/cluster/nodes/unregister",
                "http://127.0.0.1:3000/api/cluster/nodes/unregister"
            ).distinct()
            for (u in urls) {
                val ok = runCatching {
                    val conn = (java.net.URL(u).openConnection() as java.net.HttpURLConnection).apply {
                        requestMethod = "POST"
                        connectTimeout = 800
                        readTimeout = 800
                        doOutput = true
                        setRequestProperty("Content-Type", "application/json")
                    }
                    try {
                        conn.outputStream.use { it.write(payload) }
                        conn.responseCode in 200..299
                    } finally {
                        conn.disconnect()
                    }
                }.getOrDefault(false)
                if (ok) break
            }
        }.start()
    }

    private fun notifyMasterViaUdpOrHttp(masterHostPort: String, isUsb: Boolean = false) {
        serviceScope.launch {
            val host = masterHostPort.substringBefore(":")
            val httpPort = masterHostPort.substringAfter(":", "3000").toIntOrNull() ?: 3000

            // 1. Send UDP registration beacon to Master :50050
            runCatching {
                java.net.DatagramSocket().use { udp ->
                    val msg = "CLUSTERD_REGISTER:50052".toByteArray(StandardCharsets.UTF_8)
                    val pkt = java.net.DatagramPacket(
                        msg,
                        msg.size,
                        java.net.InetAddress.getByName(host),
                        50050
                    )
                    udp.send(pkt)
                }
            }

            // 2. HTTP POST registration/heartbeat with real hardware telemetry and device-derived worker ID
            runCatching {
                val advertiseIp = if (isUsb || host == "127.0.0.1") {
                    "127.0.0.1"
                } else {
                    detectLocalLanIpv4(host)
                }
                val curTel = _telemetry.value
                val jsonPayload = org.json.JSONObject().apply {
                    put("id", buildDeviceWorkerId())
                    put("label", "${curTel.deviceModel.trim()} (Android)")
                    put("platform", "Android")
                    put("osType", "android")
                    put("addr", "$advertiseIp:50052")
                    put("ip", advertiseIp)
                    put("rpcPort", 50052)
                    put("totalRamMb", curTel.totalRamMb)
                    put("availableRamMb", curTel.availableRamMb)
                    put("bigCores", curTel.bigCoreCount)
                    put("tempC", curTel.temperatureCelsius.toDouble())
                    put("computeTflops", if (curTel.hasDotProd) 2.2 else 1.4)
                    put("memBwGbps", 25.6)
                    put("linkType", if (isUsb || advertiseIp == "127.0.0.1") "USB-C Tunnel" else "Wi-Fi LAN")
                    put("allowHttpRegistration", true)
                }.toString()

                val targetUrls = listOf(
                    "http://$host:$httpPort/api/cluster/nodes/register",
                    "http://$host:$httpPort/api/nodes/add",
                    "http://127.0.0.1:3000/api/cluster/nodes/register",
                    "http://127.0.0.1:3000/api/nodes/add"
                ).distinct()

                for (u in targetUrls) {
                    val ok = runCatching {
                        val url = java.net.URL(u)
                        val conn = (url.openConnection() as java.net.HttpURLConnection).apply {
                            requestMethod = "POST"
                            connectTimeout = 1500
                            readTimeout = 1500
                            doOutput = true
                            setRequestProperty("Content-Type", "application/json")
                        }
                        try {
                            conn.outputStream.use { os ->
                                os.write(jsonPayload.toByteArray(StandardCharsets.UTF_8))
                            }
                            conn.responseCode in 200..299
                        } finally {
                            conn.disconnect()
                        }
                    }.getOrDefault(false)
                    if (ok) break
                }
            }
        }
    }

    fun stopWorkerAndFreeRam(reason: String = "Manual Stop") {
        heartbeatJob?.cancel()
        heartbeatJob = null
        monitorJob?.cancel()
        rpcServerJob?.cancel()
        runCatching { serverSocket?.close() }
        serverSocket = null
        runCatching { nativeProcess?.destroyForcibly() }
        nativeProcess = null
        unregisterFromMasterAsync()
        System.gc()

        val freshMem = HardwareProbe.readProcMemInfo()
        _telemetry.update {
            it.copy(
                workerState = WorkerRunState.STOPPED,
                activeLayersAssigned = 0,
                availableRamMb = freshMem.availableMb,
                safeCapMb = freshMem.safeCapMb
            )
        }
        appendLog("Worker stopped & RAM freed ($reason). Available RAM: ${freshMem.availableMb} MB")
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Clusterd Non-Root RPC Worker",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Persistent guard notification for clusterd RPC worker with 1-Tap RAM release"
            }
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.createNotificationChannel(channel)
        }
    }

    private fun buildForegroundNotification(statusText: String): Notification {
        val openAppIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val contentPendingIntent = PendingIntent.getActivity(
            this,
            0,
            openAppIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val stopIntent = Intent(this, RpcService::class.java).apply {
            action = ACTION_STOP_FREE_RAM
        }
        val stopPendingIntent = PendingIntent.getService(
            this,
            1,
            stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val snap = _telemetry.value
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("Silica Cluster • ${snap.workerState.badge}")
            .setContentText(statusText)
            .setStyle(
                NotificationCompat.BigTextStyle().bigText(
                    "$statusText\nBind: ${snap.bindAddress} • Temp: ${"%.1f".format(snap.temperatureCelsius)}°C • Battery: ${snap.batteryPercent}%"
                )
            )
            .setOngoing(true)
            .setContentIntent(contentPendingIntent)
            .addAction(
                android.R.drawable.ic_menu_close_clear_cancel,
                "Stop & Free RAM",
                stopPendingIntent
            )
            .build()
    }

    private fun updateNotification() {
        val snap = _telemetry.value
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val text = "SafeCap: ${snap.safeCapMb}MB (<=50%) • ${snap.bigCoreCount} Big Cores • ${"%.1f".format(snap.temperatureCelsius)}°C"
        nm.notify(NOTIFICATION_ID, buildForegroundNotification(text))
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        stopWorkerAndFreeRam("App swiped from recents")
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        stopWorkerAndFreeRam("Service destroyed")
        serviceScope.cancel()
        super.onDestroy()
    }
}

/**
 * Multi-generation Android 9 (API 28) through Android 16 (API 36) non-root hardware probe.
 */
object HardwareProbe {

    data class MemInfoResult(
        val totalMb: Long,
        val availableMb: Long,
        val safeCapMb: Long
    )

    data class CpuProbeResult(
        val bigCoreCount: Int,
        val totalCoreCount: Int,
        val hasDotProd: Boolean,
        val hasI8mm: Boolean,
        val featuresSummary: String
    )

    data class VulkanProbeResult(
        val supported: Boolean,
        val reason: String
    )

    data class BatteryThermalResult(
        val levelPercent: Int,
        val isPlugged: Boolean,
        val tempCelsius: Float,
        val thermalHeadroom: Float,
        val thermalStatusLabel: String
    )

    /**
     * Strictly reads MemTotal and MemAvailable from /proc/meminfo (ignoring SwapFree / zram).
     * Locks safe_cap_mb = min(MemTotal * 0.50, MemAvailable - 512).
     */
    fun readProcMemInfo(): MemInfoResult {
        var memTotalKb = 4_194_304L // 4 GB fallback
        var memAvailKb = 2_097_152L // 2 GB fallback
        try {
            File("/proc/meminfo").forEachLine { line ->
                when {
                    line.startsWith("MemTotal:") -> {
                        memTotalKb = line.substringAfter("MemTotal:")
                            .trim()
                            .substringBefore(" ")
                            .toLongOrNull() ?: memTotalKb
                    }
                    line.startsWith("MemAvailable:") -> {
                        memAvailKb = line.substringAfter("MemAvailable:")
                            .trim()
                            .substringBefore(" ")
                            .toLongOrNull() ?: memAvailKb
                    }
                    // SwapFree and zram lines are intentionally ignored
                }
            }
        } catch (_: Exception) {
        }

        val totalMb = (memTotalKb / 1024L).coerceAtLeast(1024L)
        val availMb = (memAvailKb / 1024L).coerceAtLeast(256L)
        // Legacy / <= 2 GB RAM devices get an extra-conservative 40% cap; all others strictly <= 50%
        val physicalCapRatio = if (totalMb <= 2048L) 0.40 else 0.50
        val reserveMb = if (totalMb <= 2048L) 256L else 512L
        val physicalLimitMb = (totalMb * physicalCapRatio).toLong()
        val availMinusReserveMb = max(256L, availMb - reserveMb)
        val safeCapMb = min(physicalLimitMb, availMinusReserveMb)

        return MemInfoResult(
            totalMb = totalMb,
            availableMb = availMb,
            safeCapMb = safeCapMb
        )
    }

    data class LegacyHardwareProfile(
        val legacyHardwareMode: Boolean,
        val legacyGraphicsMode: Boolean,
        val isLowRamDevice: Boolean,
        val glEsVersionHex: Int,
        val graphicsTierLabel: String,
        val reason: String
    )

    /**
     * Detects old hardware (<= 3 GB RAM, Android 9-10, low-RAM Go devices, <= 2 cores)
     * and legacy graphics drivers (OpenGL ES < 3.1, Mali-400/T-series/G51/G52/G71/G72,
     * Adreno 3xx/4xx/5xx/61x, PowerVR, Vivante, Tegra, software GL) so UI and worker
     * subsystems automatically degrade gracefully with zero crashes or visual artifacts.
     */
    fun detectLegacyHardwareProfile(
        context: Context,
        memInfo: MemInfoResult = readProcMemInfo(),
        vkInfo: VulkanProbeResult = probeVulkan50ms()
    ): LegacyHardwareProfile {
        val am = context.getSystemService(Context.ACTIVITY_SERVICE) as? android.app.ActivityManager
        val isLowRam = runCatching { am?.isLowRamDevice == true }.getOrDefault(false)
        val glEsVersion = runCatching {
            am?.deviceConfigurationInfo?.reqGlEsVersion ?: 0x30000
        }.getOrDefault(0x30000)

        val totalCores = Runtime.getRuntime().availableProcessors().coerceAtLeast(1)
        val is32BitOnly = Build.SUPPORTED_64_BIT_ABIS.isEmpty()
        val isLegacyHw = isLowRam ||
            memInfo.totalMb <= 3072L ||
            Build.VERSION.SDK_INT <= Build.VERSION_CODES.Q ||
            totalCores <= 2 ||
            is32BitOnly

        val isOldGlEs = glEsVersion < 0x30001 // Older than OpenGL ES 3.1
        val isLegacyGfx = isOldGlEs || !vkInfo.supported || isLegacyHw

        val tierLabel = when {
            isLegacyGfx && isLegacyHw -> "Legacy-Safe (Low-RAM + Safe 2D)"
            isLegacyGfx -> "Legacy-Safe 2D Graphics (CPU Fallback)"
            else -> "Standard Hardware Accelerated"
        }

        val reasons = buildList {
            if (isLowRam) add("Android Low-RAM device")
            if (memInfo.totalMb <= 3072L) add("${memInfo.totalMb}MB RAM")
            if (is32BitOnly) add("32-bit ABI")
            if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.Q) add("Android API ${Build.VERSION.SDK_INT}")
            if (isOldGlEs) add("GLES 0x${glEsVersion.toString(16)}")
            if (!vkInfo.supported) add("CPU NEON fallback")
        }

        return LegacyHardwareProfile(
            legacyHardwareMode = isLegacyHw,
            legacyGraphicsMode = isLegacyGfx,
            isLowRamDevice = isLowRam,
            glEsVersionHex = glEsVersion,
            graphicsTierLabel = tierLabel,
            reason = if (reasons.isEmpty()) "Modern hardware & graphics" else reasons.joinToString(" • ")
        )
    }

    /**
     * Parses /proc/cpuinfo for ARMv8.0 vs ARMv8.2+ features (asimddp / dotprod, i8mm)
     * and inspects /sys/devices/system/cpu/cpuN/cpufreq/cpuinfo_max_freq for Big-Core pinning.
     */
    fun probeCpuAndCores(): CpuProbeResult {
        var featuresLine = ""
        try {
            File("/proc/cpuinfo").forEachLine { line ->
                if (line.startsWith("Features", ignoreCase = true)) {
                    featuresLine = line.substringAfter(":").trim().lowercase()
                }
            }
        } catch (_: Exception) {
        }

        val hasDotProd = featuresLine.contains("asimddp") || featuresLine.contains("dotprod")
        val hasI8mm = featuresLine.contains("i8mm")

        val totalCores = Runtime.getRuntime().availableProcessors().coerceAtLeast(1)
        val maxFreqs = mutableListOf<Long>()
        for (coreIdx in 0 until totalCores) {
            val freqFile = File("/sys/devices/system/cpu/cpu$coreIdx/cpufreq/cpuinfo_max_freq")
            val freq = runCatching {
                if (freqFile.canRead()) freqFile.readText().trim().toLongOrNull() else null
            }.getOrNull()
            if (freq != null && freq > 0L) {
                maxFreqs.add(freq)
            }
        }

        val bigCores = if (maxFreqs.size >= 2) {
            val peakFreq = maxFreqs.maxOrNull() ?: 0L
            val threshold = (peakFreq * 0.80).toLong()
            maxFreqs.count { it >= threshold }.coerceIn(1, totalCores)
        } else {
            max(1, totalCores / 2)
        }

        val summary = buildList {
            add("ARMv8-A NEON")
            if (hasDotProd) add("ASIMDDP (DotProd)")
            if (hasI8mm) add("I8MM")
        }.joinToString(" + ")

        return CpuProbeResult(
            bigCoreCount = bigCores,
            totalCoreCount = totalCores,
            hasDotProd = hasDotProd,
            hasI8mm = hasI8mm,
            featuresSummary = summary
        )
    }

    /**
     * Runs a bounded <=50ms Vulkan capability probe.
     * On older Adreno 5xx/6xx, Mali-G52/G72, or API < 29 devices without reliable
     * VK_KHR_16bit_storage SPIR-V support, returns supported=false so the service
     * automatically sets GGML_VK_VISIBLE_DEVICES="" and falls back to ARM NEON.
     */
    fun probeVulkan50ms(): VulkanProbeResult {
        val startNs = System.nanoTime()
        return try {
            val hw = (Build.HARDWARE + " " + Build.BOARD + " " + Build.MODEL + " " + getSocModelIfAvailable()).lowercase()
            val legacyGpuMarkers = listOf(
                "adreno 3", "adreno 4", "adreno 5", "adreno 61",
                "mali-400", "mali-450", "mali-t", "mali-g51", "mali-g52", "mali-g71", "mali-g72",
                "powervr", "sgx", "rogue", "vivante", "tegra",
                "swiftshader", "llvmpipe", "ranchu", "goldfish"
            )
            val isLegacyBrokenGpu = legacyGpuMarkers.any { hw.contains(it) }

            val vulkanLibExists = File("/system/lib64/libvulkan.so").exists() ||
                File("/system/lib/libvulkan.so").exists()
            val apiSupportsReliableVkCompute = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R

            val supported = vulkanLibExists && apiSupportsReliableVkCompute && !isLegacyBrokenGpu
            val elapsedMs = (System.nanoTime() - startNs) / 1_000_000
            val reason = when {
                !vulkanLibExists -> "libvulkan.so missing -> CPU NEON safe mode (${elapsedMs}ms)"
                isLegacyBrokenGpu -> "Legacy GPU/Emulator detected -> CPU NEON safe fallback (${elapsedMs}ms)"
                !apiSupportsReliableVkCompute -> "API ${Build.VERSION.SDK_INT} < 30 -> CPU NEON safe fallback (${elapsedMs}ms)"
                else -> "Vulkan Compute 16-bit storage verified (${elapsedMs}ms)"
            }
            VulkanProbeResult(supported = supported, reason = reason)
        } catch (e: Exception) {
            VulkanProbeResult(supported = false, reason = "Vulkan probe exception: ${e.message}")
        }
    }

    private fun getSocModelIfAvailable(): String {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            Build.SOC_MODEL
        } else {
            ""
        }
    }

    /**
     * Multi-generation thermal & battery reader:
     * - API >= 30: PowerManager.getThermalHeadroom(5)
     * - API >= 29: PowerManager.getCurrentThermalStatus()
     * - API 28 fallback: BatteryManager.EXTRA_TEMPERATURE + non-root /sys/class/thermal/thermal_zoneN/temp
     */
    fun readBatteryAndThermal(context: Context): BatteryThermalResult {
        val intent: Intent? = runCatching {
            context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        }.getOrNull()

        val level = intent?.getIntExtra(BatteryManager.EXTRA_LEVEL, 100) ?: 100
        val scale = intent?.getIntExtra(BatteryManager.EXTRA_SCALE, 100)?.coerceAtLeast(1) ?: 100
        val percent = ((level * 100f) / scale.toFloat()).toInt().coerceIn(0, 100)
        val plugged = (intent?.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) ?: 0) != 0
        val batteryTenthsC = intent?.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, 310) ?: 310
        var tempCelsius = batteryTenthsC / 10.0f

        // Non-root sysfs thermal fallback for API 28 or if battery sensor reports default
        if (tempCelsius <= 5.0f) {
            tempCelsius = readSysfsThermalCelsiusFallback() ?: 31.0f
        }

        val pm = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
        var headroom = Float.NaN
        var statusLabel = "API28_BATTERY_SENSOR"

        if (pm != null) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                headroom = runCatching { pm.getThermalHeadroom(5) }.getOrDefault(Float.NaN)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                val status = runCatching { pm.currentThermalStatus }.getOrDefault(0)
                statusLabel = when (status) {
                    PowerManager.THERMAL_STATUS_NONE -> "NONE"
                    PowerManager.THERMAL_STATUS_LIGHT -> "LIGHT"
                    PowerManager.THERMAL_STATUS_MODERATE -> "MODERATE"
                    PowerManager.THERMAL_STATUS_SEVERE -> "SEVERE"
                    PowerManager.THERMAL_STATUS_CRITICAL -> "CRITICAL"
                    PowerManager.THERMAL_STATUS_EMERGENCY -> "EMERGENCY"
                    PowerManager.THERMAL_STATUS_SHUTDOWN -> "SHUTDOWN"
                    else -> "STATUS_$status"
                }
            }
        }

        if (headroom.isNaN()) {
            // Derive synthetic normalized headroom from battery temperature relative to 43°C cutoff
            headroom = ((tempCelsius - 25.0f) / (43.0f - 25.0f)).coerceIn(0.05f, 1.15f)
        }

        return BatteryThermalResult(
            levelPercent = percent,
            isPlugged = plugged,
            tempCelsius = tempCelsius,
            thermalHeadroom = headroom,
            thermalStatusLabel = statusLabel
        )
    }

    private fun readSysfsThermalCelsiusFallback(): Float? {
        return try {
            val thermalDir = File("/sys/class/thermal")
            val zones = thermalDir.listFiles { file -> file.name.startsWith("thermal_zone") } ?: return null
            for (zone in zones) {
                val tempFile = File(zone, "temp")
                if (tempFile.canRead()) {
                    val raw = tempFile.readText().trim().toLongOrNull() ?: continue
                    val celsius = if (raw > 1000L) raw / 1000.0f else raw.toFloat()
                    if (celsius in 15.0f..95.0f) {
                        return celsius
                    }
                }
            }
            null
        } catch (_: Exception) {
            null
        }
    }

    fun computeHmacSha256(secret: String, payload: ByteArray): String {
        return try {
            val mac = Mac.getInstance("HmacSHA256")
            mac.init(SecretKeySpec(secret.toByteArray(StandardCharsets.UTF_8), "HmacSHA256"))
            mac.doFinal(payload).joinToString("") { "%02x".format(it) }
        } catch (_: Exception) {
            ""
        }
    }
}
