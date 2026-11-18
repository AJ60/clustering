package com.cluster.node

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Switch
import android.widget.TextView
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import java.io.File

class MainActivity : Activity() {
    private val handler = Handler(Looper.getMainLooper())
    private lateinit var statusView: TextView
    private lateinit var metricsView: TextView
    private lateinit var lanSwitch: Switch
    private lateinit var actionButton: Button

    private val refreshRunnable = object : Runnable {
        override fun run() {
            refreshUi()
            handler.postDelayed(this, 1500)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        requestNotificationPermissionIfNeeded()

        val rootScroll = ScrollView(this).apply {
            setBackgroundColor(Color.parseColor("#0B0F17"))
        }
        val container = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(44, 56, 44, 56)
        }

        val title = TextView(this).apply {
            text = "Cluster Node Worker"
            textSize = 22f
            setTextColor(Color.parseColor("#F8FAFC"))
            setTypeface(Typeface.DEFAULT_BOLD)
        }
        val subtitle = TextView(this).apply {
            text = "llama.cpp v1.0.0 · RPC v9 · 16 KB ELF"
            textSize = 13f
            setTextColor(Color.parseColor("#94A3B8"))
            setPadding(0, 6, 0, 28)
        }

        statusView = TextView(this).apply {
            textSize = 14f
            setTextColor(Color.parseColor("#93C5FD"))
            setBackgroundColor(Color.parseColor("#121824"))
            setPadding(32, 26, 32, 26)
        }

        metricsView = TextView(this).apply {
            textSize = 13f
            typeface = Typeface.MONOSPACE
            setTextColor(Color.parseColor("#CBD5E1"))
            setBackgroundColor(Color.parseColor("#0E141E"))
            setPadding(32, 26, 32, 26)
        }

        lanSwitch = Switch(this).apply {
            text = "Allow Trusted Wi-Fi/Hotspot LAN (bind 0.0.0.0)"
            textSize = 14f
            setTextColor(Color.parseColor("#E2E8F0"))
            isChecked = false
            setPadding(0, 28, 0, 28)
        }

        actionButton = Button(this).apply {
            textSize = 15f
            gravity = Gravity.CENTER
            setTextColor(Color.WHITE)
            setPadding(24, 28, 24, 28)
            setOnClickListener { toggleWorkerService() }
        }

        val cmdHint = TextView(this).apply {
            text = "USB Master Quick-Tunnel:\nadb forward tcp:51051 tcp:50051\nadb forward tcp:50052 tcp:50052"
            textSize = 12f
            typeface = Typeface.MONOSPACE
            setTextColor(Color.parseColor("#64748B"))
            setPadding(0, 28, 0, 0)
        }

        container.addView(title)
        container.addView(subtitle)
        container.addView(statusView)
        container.addView(metricsView)
        container.addView(lanSwitch)
        container.addView(actionButton)
        container.addView(cmdHint)
        rootScroll.addView(container)
        setContentView(rootScroll)

        refreshUi()
    }

    override fun onResume() {
        super.onResume()
        handler.post(refreshRunnable)
    }

    override fun onPause() {
        super.onPause()
        handler.removeCallbacks(refreshRunnable)
    }

    private fun requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT >= 33) {
            val granted = ContextCompat.checkSelfPermission(
                this,
                Manifest.permission.POST_NOTIFICATIONS
            ) == PackageManager.PERMISSION_GRANTED
            if (!granted) {
                ActivityCompat.requestPermissions(
                    this,
                    arrayOf(Manifest.permission.POST_NOTIFICATIONS),
                    1001
                )
            }
        }
    }

    private fun toggleWorkerService() {
        if (RpcService.isRunning) {
            stopService(Intent(this, RpcService::class.java))
        } else {
            val bindHost = if (lanSwitch.isChecked) "0.0.0.0" else "127.0.0.1"
            val intent = Intent(this, RpcService::class.java).apply {
                putExtra(RpcService.EXTRA_BIND_HOST, bindHost)
            }
            ContextCompat.startForegroundService(this, intent)
        }
        handler.postDelayed({ refreshUi() }, 250)
    }

    private fun refreshUi() {
        val running = RpcService.isRunning
        val mem = RpcService.readAndroidMemStats()
        val tempC = RpcService.readAndroidTempC()
        val rpcExists = File(applicationInfo.nativeLibraryDir, "librpc_server_exec.so").exists()
        val clusterdExists = File(applicationInfo.nativeLibraryDir, "libclusterd_exec.so").exists()

        statusView.text = if (running) {
            "ACTIVE · Bind ${RpcService.activeBindHost}:50052 (Probe :50051)\nMode: ${if (clusterdExists) "Rust clusterd + rpc-server" else "Kotlin Probe + rpc-server"}"
        } else {
            "IDLE · Tap Start Worker to expose RPC v9 + 32-byte GGUF handshake"
        }

        metricsView.text = buildString {
            appendLine("Device SoC   : ${Build.HARDWARE} (${Build.MODEL})")
            appendLine("Physical RAM : ${mem.totalMb} MB (${mem.availMb} MB Avail)")
            appendLine("Strict Cap   : ${mem.safeCapMb} MB (<=50%, zram ignored)")
            appendLine("Thermal      : ${"%.1f".format(tempC)} C")
            appendLine("Native Bins  : rpc-server=${if (rpcExists) "READY" else "MISSING"} · clusterd=${if (clusterdExists) "READY" else "KOTLIN_BRIDGE"}")
        }

        actionButton.text = if (running) "Stop Worker Service" else "Start Cluster Worker"
        actionButton.setBackgroundColor(
            Color.parseColor(if (running) "#DC2626" else "#2563EB")
        )
        lanSwitch.isEnabled = !running
    }
}
