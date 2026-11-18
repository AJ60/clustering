package com.cluster.node

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import java.io.BufferedReader
import java.io.File
import java.io.InputStreamReader
import kotlin.concurrent.thread
import kotlin.math.min

/**
 * RpcService — Foreground Service managing llama.cpp rpc-server on Android.
 * Enforces strict 50% physical RAM cap (excluding zram/swap),
 * acquires PARTIAL_WAKE_LOCK and low-latency Wi-Fi lock, and executes
 * librpc_server_exec.so directly from nativeLibraryDir.
 */
class RpcService : Service() {

    companion object {
        private const val TAG = "ClusterRpcService"
        private const val CHANNEL_ID = "rpc_service_channel"
        private const val NOTIFICATION_ID = 50052
        private const val RPC_PORT = 50052
    }

    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null
    private var rpcProcess: Process? = null
    private var isRunning = false

    override fun onCreate() {
        super.onCreate()
        Log.i(TAG, "Initializing Cluster RPC Service")
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (!isRunning) {
            isRunning = true
            startForegroundServiceWithNotification()
            acquireLocks()
            val safeCapMb = computeSafeRamCapMb()
            launchRpcServer(safeCapMb)
        }
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        super.onDestroy()
        Log.i(TAG, "Stopping Cluster RPC Service")
        isRunning = false
        stopRpcServer()
        releaseLocks()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "GGUF Cluster RPC Node",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "High-performance AI inference node running llama.cpp rpc-server"
            }
            val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            manager.createNotificationChannel(channel)
        }
    }

    private fun startForegroundServiceWithNotification() {
        val notificationBuilder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }

        val notification = notificationBuilder
            .setContentTitle("GGUF Cluster Worker Online")
            .setContentText("Serving stock llama.cpp RPC v9 on port $RPC_PORT")
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setOngoing(true)
            .build()

        startForeground(NOTIFICATION_ID, notification)
    }

    private fun acquireLocks() {
        try {
            val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
            wakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Cluster:RpcWakeLock").apply {
                setReferenceCounted(false)
                acquire()
            }
            Log.i(TAG, "Acquired PARTIAL_WAKE_LOCK")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to acquire PARTIAL_WAKE_LOCK: ${e.message}")
        }

        try {
            val wifiManager = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
            val lockMode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                WifiManager.WIFI_MODE_FULL_LOW_LATENCY
            } else {
                @Suppress("DEPRECATION")
                WifiManager.WIFI_MODE_FULL_HIGH_PERF
            }
            wifiLock = wifiManager.createWifiLock(lockMode, "Cluster:WifiLock").apply {
                setReferenceCounted(false)
                acquire()
            }
            Log.i(TAG, "Acquired low-latency WifiLock mode=$lockMode")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to acquire WifiLock: ${e.message}")
        }
    }

    private fun releaseLocks() {
        try {
            wakeLock?.let {
                if (it.isHeld) it.release()
                Log.i(TAG, "Released PARTIAL_WAKE_LOCK")
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error releasing wakeLock: ${e.message}")
        }
        wakeLock = null

        try {
            wifiLock?.let {
                if (it.isHeld) it.release()
                Log.i(TAG, "Released WifiLock")
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error releasing wifiLock: ${e.message}")
        }
        wifiLock = null
    }

    /**
     * Strict 50% Android Physical RAM Cap:
     * safe_cap_mb = int(min(0.50 * ram_total_mb, ram_avail_mb - 512))
     * Strictly ignores zram and swap.
     */
    private fun computeSafeRamCapMb(): Int {
        var ramTotalMb = 4096
        var ramAvailMb = 2048

        val meminfoFile = File("/proc/meminfo")
        if (meminfoFile.exists()) {
            try {
                meminfoFile.forEachLine { line ->
                    val parts = line.split(":")
                    if (parts.size == 2) {
                        val key = parts[0].trim()
                        val valueStr = parts[1].trim().split(" ")[0]
                        val valueKb = valueStr.toIntOrNull() ?: 0
                        if (key == "MemTotal") {
                            ramTotalMb = valueKb / 1024
                        } else if (key == "MemAvailable") {
                            ramAvailMb = valueKb / 1024
                        }
                    }
                }
            } catch (e: Exception) {
                Log.e(TAG, "Error parsing /proc/meminfo: ${e.message}")
            }
        }

        val rawCap = min(0.50 * ramTotalMb, (ramAvailMb - 512).toDouble()).toInt()
        val safeCapMb = rawCap.coerceAtLeast(256)
        Log.i(TAG, "RAM Telemetry: Total=${ramTotalMb}MB, Avail=${ramAvailMb}MB -> SafeCap=${safeCapMb}MB")
        return safeCapMb
    }

    private fun launchRpcServer(safeCapMb: Int) {
        thread(start = true, name = "RpcServerExecutor") {
            try {
                val nativeDir = applicationInfo.nativeLibraryDir
                val rpcExec = File(nativeDir, "librpc_server_exec.so")

                if (!rpcExec.exists()) {
                    Log.w(TAG, "Native executable ${rpcExec.absolutePath} not found. Standby for APK packaging.")
                    return@thread
                }

                rpcExec.setExecutable(true, false)

                val cmd = listOf(
                    rpcExec.absolutePath,
                    "-H", "0.0.0.0",
                    "-p", RPC_PORT.toString(),
                    "-c",
                    "-m", safeCapMb.toString()
                )

                Log.i(TAG, "Spawning rpc-server: ${cmd.joinToString(" ")}")
                val processBuilder = ProcessBuilder(cmd)
                processBuilder.redirectErrorStream(true)
                rpcProcess = processBuilder.start()

                val reader = BufferedReader(InputStreamReader(rpcProcess?.inputStream))
                var line: String?
                while (isRunning && reader.readLine().also { line = it } != null) {
                    Log.d(TAG, "[rpc-server] $line")
                }

                val exitCode = rpcProcess?.waitFor() ?: -1
                Log.i(TAG, "rpc-server exited with code $exitCode")
            } catch (e: Exception) {
                Log.e(TAG, "Failed running rpc-server process: ${e.message}", e)
            }
        }
    }

    private fun stopRpcServer() {
        try {
            rpcProcess?.let {
                Log.i(TAG, "Terminating rpc-server process")
                it.destroy()
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error destroying rpc-server process: ${e.message}")
        }
        rpcProcess = null
    }
}
