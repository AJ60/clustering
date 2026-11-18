package com.cluster.node

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import org.json.JSONObject
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.File
import java.net.DatagramPacket
import java.net.InetAddress
import java.net.MulticastSocket
import java.net.ServerSocket
import java.net.Socket
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.charset.StandardCharsets
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

data class AndroidMemStats(val totalMb: Long, val availMb: Long, val safeCapMb: Long)

class RpcService : Service() {
    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null
    private var multicastLock: WifiManager.MulticastLock? = null
    private var rpcProcess: Process? = null
    private var clusterdProcess: Process? = null
    private val serviceRunning = AtomicBoolean(false)
    private var tcpServerSocket: ServerSocket? = null
    private var udpSocket: MulticastSocket? = null

    companion object {
        const val EXTRA_BIND_HOST = "bind_host"
        const val PROBE_PORT = 50051
        const val RPC_PORT = 50052
        const val MCAST_ADDR = "239.255.77.88"
        const val MCAST_PORT = 50050
        const val RPC_VERSION_PIN = 9
        const val LLAMA_TAG_PIN = "v1.0.0"

        @Volatile
        var isRunning: Boolean = false
            private set

        @Volatile
        var activeBindHost: String = "127.0.0.1"
            private set

        fun readAndroidMemStats(): AndroidMemStats {
            var totalKb = 4096L * 1024L
            var availKb = 2048L * 1024L
            try {
                File("/proc/meminfo").forEachLine { line ->
                    val parts = line.split(":")
                    if (parts.size == 2) {
                        val key = parts[0].trim()
                        val v = parts[1].trim().split(Regex("\\s+")).firstOrNull()?.toLongOrNull() ?: 0L
                        if (key == "MemTotal") totalKb = v
                        else if (key == "MemAvailable") availKb = v
                    }
                }
            } catch (_: Exception) {}
            val totalMb = (totalKb / 1024L).coerceAtLeast(512L)
            val availMb = (availKb / 1024L).coerceAtLeast(256L)
            // Strict <=50% Android Physical RAM cap (ignores SwapFree / zram completely)
            val safeCapMb = minOf(totalMb / 2L, maxOf(256L, availMb - 512L)).coerceAtLeast(256L)
            return AndroidMemStats(totalMb, availMb, safeCapMb)
        }

        fun readAndroidTempC(): Double {
            var tempC = 36.0
            try {
                File("/sys/class/thermal").listFiles()?.forEach { zone ->
                    if (zone.name.startsWith("thermal_zone")) {
                        val raw = File(zone, "temp").takeIf { it.exists() }?.readText()?.trim()?.toDoubleOrNull()
                        if (raw != null) {
                            val norm = if (raw > 1000.0) raw / 1000.0 else raw
                            if (norm in 15.0..105.0) {
                                tempC = maxOf(tempC, norm)
                            }
                        }
                    }
                }
                val bat = File("/sys/class/power_supply/battery/temp").takeIf { it.exists() }?.readText()?.trim()?.toDoubleOrNull()
                if (bat != null) {
                    val norm = if (bat > 200.0) bat / 10.0 else bat
                    if (norm in 15.0..80.0) tempC = maxOf(tempC, norm)
                }
            } catch (_: Exception) {}
            return kotlin.math.round(tempC * 10.0) / 10.0
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val bindHost = intent?.getStringExtra(EXTRA_BIND_HOST)?.takeIf { it == "0.0.0.0" || it == "127.0.0.1" }
            ?: "127.0.0.1"
        activeBindHost = bindHost
        serviceRunning.set(true)
        isRunning = true

        startForegroundChannel(bindHost)
        acquireLocks()
        launchNativeWorkerOrBridge(bindHost)
        return START_STICKY
    }

    private fun startForegroundChannel(bindHost: String) {
        val channelId = "cluster_rpc_channel"
        val mgr = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val channel = NotificationChannel(
            channelId,
            "GGUF RPC Worker",
            NotificationManager.IMPORTANCE_LOW
        )
        mgr.createNotificationChannel(channel)

        val openIntent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE
        )

        val notification = Notification.Builder(this, channelId)
            .setContentTitle("Cluster RPC Worker Active")
            .setContentText("llama.cpp v1.0.0 (RPC v9) · $bindHost:$RPC_PORT")
            .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
            .setContentIntent(openIntent)
            .build()

        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(101, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(101, notification)
        }
    }

    private fun acquireLocks() {
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "cluster:RpcWakeLock").apply {
            acquire(12 * 60 * 60 * 1000L)
        }
        val wm = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
        wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_LOW_LATENCY, "cluster:RpcWifiLock").apply {
            acquire()
        }
        multicastLock = wm.createMulticastLock("cluster:MulticastLock").apply {
            setReferenceCounted(false)
            acquire()
        }
    }

    private fun launchNativeWorkerOrBridge(bindHost: String) {
        val nativeDir = applicationInfo.nativeLibraryDir
        val clusterdExec = File(nativeDir, "libclusterd_exec.so")
        val rpcExec = File(nativeDir, "librpc_server_exec.so")

        if (clusterdExec.exists()) {
            try {
                val args = mutableListOf(clusterdExec.absolutePath, "worker", "android-${Build.MODEL.replace(" ", "-")}", "$RPC_PORT")
                if (bindHost == "0.0.0.0") args.add("--lan")
                val pb = ProcessBuilder(args)
                pb.environment()["CLUSTER_RPC_BIND"] = bindHost
                if (rpcExec.exists()) {
                    pb.environment()["RPC_SERVER_BIN"] = rpcExec.absolutePath
                }
                pb.redirectErrorStream(true)
                clusterdProcess = pb.start()
                Log.i("RpcService", "Started Rust libclusterd_exec.so worker ($bindHost)")
                return
            } catch (e: Exception) {
                Log.w("RpcService", "Falling back to Kotlin probe + librpc_server_exec.so", e)
            }
        }

        if (rpcExec.exists()) {
            val mem = readAndroidMemStats()
            try {
                val pb = ProcessBuilder(
                    rpcExec.absolutePath,
                    "-H", bindHost,
                    "-p", "$RPC_PORT",
                    "-c",
                    "-m", mem.safeCapMb.toString()
                )
                pb.redirectErrorStream(true)
                rpcProcess = pb.start()
                Log.i("RpcService", "Started librpc_server_exec.so on $bindHost:$RPC_PORT (-m ${mem.safeCapMb} MB)")
            } catch (e: Exception) {
                Log.e("RpcService", "Failed to start librpc_server_exec.so", e)
            }
        } else {
            Log.w("RpcService", "Missing librpc_server_exec.so in $nativeDir; running handshake responder only")
        }

        startKotlinProbeResponder(bindHost)
        if (bindHost == "0.0.0.0") {
            startKotlinMulticastResponder()
        }
    }

    private fun encodeHandshake(): ByteArray {
        val buf = ByteBuffer.allocate(32).order(ByteOrder.BIG_ENDIAN)
        buf.put("GGUF".toByteArray(StandardCharsets.US_ASCII))
        buf.putInt(RPC_VERSION_PIN)
        val tag = LLAMA_TAG_PIN.toByteArray(StandardCharsets.US_ASCII)
        buf.put(tag, 0, minOf(tag.size, 16))
        return buf.array()
    }

    private fun buildTelemetryJson(bindHost: String): ByteArray {
        val mem = readAndroidMemStats()
        val tempC = readAndroidTempC()
        val headroom = ((tempC - 26.0) / (50.0 - 26.0)).coerceIn(0.0, 1.0)
        val obj = JSONObject().apply {
            put("node_id", "android-${Build.MODEL.replace(" ", "-").lowercase()}")
            put("os", "android_apk")
            put("isa", "ARMv8.2+ DotProd")
            put("silicon", "${Build.MANUFACTURER} ${Build.HARDWARE}")
            put("perf_cores", Runtime.getRuntime().availableProcessors().coerceAtMost(8) / 2)
            put("ram_total_mb", mem.totalMb)
            put("ram_avail_mb", mem.availMb)
            put("safe_cap_mb", mem.safeCapMb)
            put("compute_tflops", 2.0)
            put("mem_bw_gbps", 48.0)
            put("disk_mbps", 650.0)
            put("cpu_temp_c", tempC)
            put("cpu_util_pct", 12.0)
            put("thermal_headroom", kotlin.math.round(headroom * 100.0) / 100.0)
            put("vulkan_active", true)
            put("execution_backend", "Vulkan 1.4 (16KB ELF)")
            put("rpc_port", RPC_PORT)
            put("rpc_bind", bindHost)
        }
        return obj.toString().toByteArray(StandardCharsets.UTF_8)
    }

    private fun startKotlinProbeResponder(bindHost: String) {
        thread(isDaemon = true) {
            try {
                val server = ServerSocket(PROBE_PORT, 16, InetAddress.getByName(bindHost))
                tcpServerSocket = server
                while (serviceRunning.get()) {
                    val sock: Socket = try {
                        server.accept()
                    } catch (_: Exception) {
                        break
                    }
                    thread(isDaemon = true) {
                        sock.use { client ->
                            try {
                                client.tcpNoDelay = true
                                val input = DataInputStream(client.getInputStream())
                                val output = DataOutputStream(client.getOutputStream())
                                val hs = ByteArray(32)
                                input.readFully(hs)
                                val magic = String(hs, 0, 4, StandardCharsets.US_ASCII)
                                val rpcVer = ByteBuffer.wrap(hs, 4, 4).order(ByteOrder.BIG_ENDIAN).int
                                val tagEnd = (8 until 24).firstOrNull { hs[it].toInt() == 0 } ?: 24
                                val gitTag = String(hs, 8, tagEnd - 8, StandardCharsets.US_ASCII)
                                if (magic == "GGUF" && rpcVer == RPC_VERSION_PIN && gitTag == LLAMA_TAG_PIN) {
                                    output.write(encodeHandshake())
                                    val jsonBytes = buildTelemetryJson(bindHost)
                                    output.writeInt(jsonBytes.size)
                                    output.write(jsonBytes)
                                    output.flush()
                                    val ping = ByteArray(16 * 1024)
                                    while (serviceRunning.get()) {
                                        input.readFully(ping)
                                        output.write(ping)
                                        output.flush()
                                    }
                                }
                            } catch (_: Exception) {}
                        }
                    }
                }
            } catch (e: Exception) {
                Log.e("RpcService", "Kotlin probe listener error", e)
            }
        }
    }

    private fun startKotlinMulticastResponder() {
        thread(isDaemon = true) {
            try {
                val group = InetAddress.getByName(MCAST_ADDR)
                val sock = MulticastSocket(MCAST_PORT)
                udpSocket = sock
                sock.soTimeout = 1000
                @Suppress("DEPRECATION")
                sock.joinGroup(group)
                val buf = ByteArray(128)
                val deviceId = "android-${Build.MODEL.replace(" ", "-").lowercase()}"
                while (serviceRunning.get()) {
                    val pkt = DatagramPacket(buf, buf.size)
                    try {
                        sock.receive(pkt)
                        val msg = String(pkt.data, 0, pkt.length, StandardCharsets.UTF_8)
                        if (msg == "CLUSTERD_DISCOVER_V1") {
                            val reply = "CLUSTERD_SPOKE $PROBE_PORT $RPC_PORT $deviceId".toByteArray(StandardCharsets.UTF_8)
                            sock.send(DatagramPacket(reply, reply.size, pkt.address, pkt.port))
                        }
                    } catch (_: java.net.SocketTimeoutException) {}
                }
            } catch (e: Exception) {
                Log.e("RpcService", "Multicast responder error", e)
            }
        }
    }

    override fun onDestroy() {
        isRunning = false
        serviceRunning.set(false)
        try { tcpServerSocket?.close() } catch (_: Exception) {}
        try { udpSocket?.close() } catch (_: Exception) {}
        clusterdProcess?.destroy()
        rpcProcess?.destroy()
        multicastLock?.let { if (it.isHeld) it.release() }
        wakeLock?.let { if (it.isHeld) it.release() }
        wifiLock?.let { if (it.isHeld) it.release() }
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
