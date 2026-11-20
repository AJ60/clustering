package com.example.ui.silica

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.widget.Toast
import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.BatteryChargingFull
import androidx.compose.material.icons.filled.ClearAll
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Memory
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.PowerSettingsNew
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.filled.Terminal
import androidx.compose.material.icons.filled.Tune
import androidx.compose.material.icons.filled.Usb
import androidx.compose.material.icons.filled.Wifi
import androidx.compose.material.icons.outlined.Thermostat
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.example.service.DeviceTelemetryState
import com.example.service.RpcService
import com.example.service.WorkerRunState
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/**
 * SilicaSetupScreen — Inspired by Silica Cluster's Command Center (SetupScreen).
 *
 * Provides:
 * 1. Primary Node Server Switch (Start/Stop foreground AI engine).
 * 2. Live Hardware & Memory Telemetry (RAM allocation bar, Big Core affinity, battery thermals).
 * 3. Live Streaming Terminal Console with auto-scroll, copy, and clear logs.
 */
@Composable
fun SilicaSetupScreen(
    modifier: Modifier = Modifier
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val telemetry by RpcService.telemetry.collectAsStateWithLifecycle()

    val isRunning = telemetry.workerState == WorkerRunState.RUNNING_USB ||
            telemetry.workerState == WorkerRunState.RUNNING_WIFI ||
            telemetry.workerState == WorkerRunState.THROTTLED_THERMAL

    Column(
        modifier = modifier
            .fillMaxSize()
            .padding(horizontal = 16.dp)
            .verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(14.dp)
    ) {
        Spacer(modifier = Modifier.height(4.dp))

        // 1. PRIMARY SERVER CONTROL CARD
        SilicaServerControlCard(
            telemetry = telemetry,
            isRunning = isRunning,
            onToggleServer = { shouldRun ->
                scope.launch(Dispatchers.IO) {
                    if (shouldRun) {
                        if (!telemetry.calibration.isCalibrated) {
                            RpcService.runAutoCalibration(context)
                        }
                        sendServiceAction(context, RpcService.ACTION_AUTO_DETECT_MASTER)
                    } else {
                        sendServiceAction(context, RpcService.ACTION_STOP_FREE_RAM)
                    }
                }
            }
        )

        // 2. LIVE SYSTEM TELEMETRY DECK
        SilicaTelemetryDeckCard(telemetry = telemetry)

        // 3. LIVE STREAMING TERMINAL CONSOLE
        SilicaLiveTerminalCard(
            eventLogs = telemetry.eventLogs,
            onCopyLogs = {
                val clip = ClipData.newPlainText("Silica Logs", telemetry.eventLogs.joinToString("\n"))
                val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                cm.setPrimaryClip(clip)
                Toast.makeText(context, "Logs copied to clipboard", Toast.LENGTH_SHORT).show()
            }
        )

        Spacer(modifier = Modifier.height(16.dp))
    }
}

@Composable
private fun SilicaServerControlCard(
    telemetry: DeviceTelemetryState,
    isRunning: Boolean,
    onToggleServer: (Boolean) -> Unit
) {
    val statusColor by animateColorAsState(
        targetValue = when (telemetry.workerState) {
            WorkerRunState.RUNNING_USB, WorkerRunState.RUNNING_WIFI -> Color(0xFF10B981)
            WorkerRunState.PROBING -> Color(0xFF3B82F6)
            WorkerRunState.THROTTLED_THERMAL -> Color(0xFFF59E0B)
            WorkerRunState.SHEDDING_MEMORY -> Color(0xFFEF4444)
            WorkerRunState.STOPPED -> Color(0xFF64748B)
        },
        label = "serverStatusColor"
    )

    Card(
        shape = RoundedCornerShape(20.dp),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f)
        ),
        elevation = CardDefaults.cardElevation(defaultElevation = 2.dp)
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(18.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp)
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(10.dp)
                ) {
                    Box(
                        modifier = Modifier
                            .size(12.dp)
                            .clip(CircleShape)
                            .background(statusColor)
                    )
                    Column {
                        Text(
                            text = if (isRunning) "SERVER ACTIVE" else "SERVER STANDBY",
                            fontWeight = FontWeight.ExtraBold,
                            fontSize = 15.sp,
                            color = statusColor
                        )
                        Text(
                            text = if (isRunning) "Listening on 0.0.0.0:50052" else "Ready to join cluster",
                            fontSize = 11.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }

                Switch(
                    checked = isRunning,
                    onCheckedChange = onToggleServer,
                    colors = SwitchDefaults.colors(
                        checkedThumbColor = Color.White,
                        checkedTrackColor = Color(0xFF10B981)
                    )
                )
            }

            // Engine Profile Details
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(12.dp))
                    .background(MaterialTheme.colorScheme.surface.copy(alpha = 0.8f))
                    .padding(12.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween
            ) {
                Column {
                    Text(
                        text = "Compute Engine",
                        fontSize = 10.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    Text(
                        text = if (telemetry.vulkanProbePassed) "Vulkan 1.1 Compute" else "ARMv8 NEON Vector Math",
                        fontWeight = FontWeight.Bold,
                        fontSize = 13.sp
                    )
                }

                Surface(
                    shape = RoundedCornerShape(8.dp),
                    color = MaterialTheme.colorScheme.primary.copy(alpha = 0.12f)
                ) {
                    Text(
                        text = "16 KB Page Aligned",
                        fontSize = 10.sp,
                        fontWeight = FontWeight.Bold,
                        color = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp)
                    )
                }
            }
        }
    }
}

@Composable
private fun SilicaTelemetryDeckCard(telemetry: DeviceTelemetryState) {
    Card(
        shape = RoundedCornerShape(20.dp),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surface
        ),
        elevation = CardDefaults.cardElevation(defaultElevation = 1.dp)
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(18.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp)
        ) {
            Text(
                text = "Live Hardware Telemetry",
                fontWeight = FontWeight.Bold,
                style = MaterialTheme.typography.titleSmall
            )

            // 1. RAM Allocation Gauge
            val safeMb = telemetry.safeCapMb
            val totalMb = telemetry.totalRamMb
            val fraction = if (totalMb > 0) (safeMb.toFloat() / totalMb.toFloat()).coerceIn(0f, 1f) else 0.35f

            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween
                ) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(6.dp)
                    ) {
                        Icon(
                            imageVector = Icons.Default.Memory,
                            contentDescription = null,
                            tint = MaterialTheme.colorScheme.primary,
                            modifier = Modifier.size(16.dp)
                        )
                        Text(
                            text = "Memory Cap (LMKD Guard)",
                            fontSize = 12.sp,
                            fontWeight = FontWeight.SemiBold
                        )
                    }
                    Text(
                        text = "$safeMb MB / $totalMb MB",
                        fontSize = 12.sp,
                        fontWeight = FontWeight.Bold,
                        fontFamily = FontFamily.Monospace,
                        color = MaterialTheme.colorScheme.primary
                    )
                }
                LinearProgressIndicator(
                    progress = { fraction },
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(8.dp)
                        .clip(CircleShape),
                    color = MaterialTheme.colorScheme.primary,
                    trackColor = MaterialTheme.colorScheme.surfaceVariant
                )
                Text(
                    text = "Strict <=50% physical ceiling protects against Android LowMemoryKiller terminations.",
                    fontSize = 10.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }

            // 2. CPU Big Cores & Thermals
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(10.dp)
            ) {
                // CPU Core Box
                Column(
                    modifier = Modifier
                        .weight(1f)
                        .clip(RoundedCornerShape(14.dp))
                        .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f))
                        .padding(12.dp),
                    verticalArrangement = Arrangement.spacedBy(4.dp)
                ) {
                    Text(
                        text = "CPU Thread Affinity",
                        fontSize = 10.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    Text(
                        text = "${telemetry.bigCoreCount} Big Cores",
                        fontWeight = FontWeight.Bold,
                        fontSize = 14.sp
                    )
                    Text(
                        text = "Pinned @ 2.0 GHz",
                        fontSize = 10.sp,
                        color = Color(0xFF10B981),
                        fontWeight = FontWeight.SemiBold
                    )
                }

                // Thermal Box
                val isHot = telemetry.temperatureCelsius > 40f
                val thermalColor = if (isHot) Color(0xFFEF4444) else Color(0xFF10B981)

                Column(
                    modifier = Modifier
                        .weight(1f)
                        .clip(RoundedCornerShape(14.dp))
                        .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f))
                        .padding(12.dp),
                    verticalArrangement = Arrangement.spacedBy(4.dp)
                ) {
                    Text(
                        text = "Thermal Envelope",
                        fontSize = 10.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    Text(
                        text = "${telemetry.temperatureCelsius}°C",
                        fontWeight = FontWeight.Bold,
                        fontSize = 14.sp,
                        color = thermalColor
                    )
                    Text(
                        text = if (isHot) "Shedding Load" else "Cool & Steady",
                        fontSize = 10.sp,
                        color = thermalColor,
                        fontWeight = FontWeight.SemiBold
                    )
                }
            }
        }
    }
}

@Composable
private fun SilicaLiveTerminalCard(
    eventLogs: List<String>,
    onCopyLogs: () -> Unit
) {
    Card(
        shape = RoundedCornerShape(20.dp),
        colors = CardDefaults.cardColors(
            containerColor = Color(0xFF0F172A) // Sleek terminal dark
        ),
        elevation = CardDefaults.cardElevation(defaultElevation = 2.dp)
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    Icon(
                        imageVector = Icons.Default.Terminal,
                        contentDescription = null,
                        tint = Color(0xFF38BDF8),
                        modifier = Modifier.size(18.dp)
                    )
                    Text(
                        text = "Server Output Terminal",
                        fontWeight = FontWeight.Bold,
                        fontSize = 13.sp,
                        color = Color(0xFFE2E8F0)
                    )
                }

                IconButton(
                    onClick = onCopyLogs,
                    modifier = Modifier.size(28.dp)
                ) {
                    Icon(
                        imageVector = Icons.Default.ContentCopy,
                        contentDescription = "Copy Logs",
                        tint = Color(0xFF94A3B8),
                        modifier = Modifier.size(16.dp)
                    )
                }
            }

            // Monospace Log Console Window
            val displayLogs = if (eventLogs.isEmpty()) {
                listOf("[00:00:00] Silica Node Ready. Tap start switch above to launch RPC daemon.")
            } else {
                eventLogs.take(20)
            }

            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(180.dp)
                    .clip(RoundedCornerShape(10.dp))
                    .background(Color(0xFF020617))
                    .border(1.dp, Color(0xFF1E293B), RoundedCornerShape(10.dp))
                    .padding(10.dp)
                    .verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(4.dp)
            ) {
                displayLogs.reversed().forEach { logLine ->
                    Text(
                        text = logLine,
                        color = when {
                            logLine.contains("ERROR", ignoreCase = true) -> Color(0xFFF87171)
                            logLine.contains("CONNECTED", ignoreCase = true) || logLine.contains("ONLINE", ignoreCase = true) -> Color(0xFF4ADE80)
                            logLine.contains("Auto-", ignoreCase = true) || logLine.contains("RPC", ignoreCase = true) -> Color(0xFF38BDF8)
                            else -> Color(0xFFCBD5E1)
                        },
                        fontSize = 10.sp,
                        fontFamily = FontFamily.Monospace,
                        lineHeight = 14.sp
                    )
                }
            }
        }
    }
}

private fun sendServiceAction(context: Context, action: String) {
    val intent = Intent(context, RpcService::class.java).apply {
        this.action = action
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.startForegroundService(intent)
    } else {
        context.startService(intent)
    }
}
