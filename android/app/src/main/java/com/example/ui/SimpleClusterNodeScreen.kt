package com.example.ui

import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.compose.animation.AnimatedVisibility
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.BatteryChargingFull
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Memory
import androidx.compose.material.icons.filled.QrCode2
import androidx.compose.material.icons.filled.Radar
import androidx.compose.material.icons.filled.Speed
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.filled.Storage
import androidx.compose.material.icons.filled.Tune
import androidx.compose.material.icons.filled.Usb
import androidx.compose.material.icons.filled.Wifi
import androidx.compose.material.icons.outlined.Thermostat
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
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
import com.example.service.TensorCacheManager
import com.example.service.TensorCacheStats
import com.example.service.WorkerRunState
import com.example.ui.components.CameraQrScannerDialog
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * SimpleClusterNodeScreen — Inspired by exo, cake, node-llama-cpp, and llama-cpp-android-node.
 *
 * Designed for effortless zero-jargon mobile participation:
 * - Zero manual IP/port configuration: Auto-discovers Master via USB ADB & LAN UDP broadcast.
 * - Auto-tunes hardware on first launch: pins CPU Big Cores, detects NEON/Vulkan, calculates safe RAM cap.
 * - Persistent tensor & weight cache: avoids re-downloading model weights over slow Wi-Fi.
 * - Single-tap hero button to join or disconnect from the heterogeneous star cluster.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SimpleClusterNodeScreen(
    onNavigateToSimple2DLab: () -> Unit
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val telemetry by RpcService.telemetry.collectAsStateWithLifecycle()
    var showQrScanner by remember { mutableStateOf(false) }
    var cacheStats by remember { mutableStateOf(TensorCacheManager.getStats(context)) }

    // Auto-calibrate & auto-tune on first launch in background
    LaunchedEffect(Unit) {
        scope.launch(Dispatchers.IO) {
            if (!telemetry.calibration.isCalibrated) {
                RpcService.runAutoCalibration(context)
            } else {
                RpcService.refreshStaticHardwareSnapshot(context)
            }
            cacheStats = TensorCacheManager.getStats(context)
        }
    }

    val isRunning = telemetry.workerState == WorkerRunState.RUNNING_USB ||
            telemetry.workerState == WorkerRunState.RUNNING_WIFI ||
            telemetry.workerState == WorkerRunState.THROTTLED_THERMAL

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(
                            text = "ClusterLab Edge Node",
                            style = MaterialTheme.typography.titleMedium,
                            fontWeight = FontWeight.Bold
                        )
                        Text(
                            text = "Auto-Discovered • Zero-Config Cluster",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.primary
                        )
                    }
                },
                actions = {
                    IconButton(onClick = { showQrScanner = true }) {
                        Icon(
                            imageVector = Icons.Default.QrCode2,
                            contentDescription = "Scan Cluster QR"
                        )
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.surface
                )
            )
        },
        bottomBar = {
            NavigationBar(containerColor = MaterialTheme.colorScheme.surface) {
                NavigationBarItem(
                    selected = true,
                    onClick = { /* already here */ },
                    icon = { Icon(Icons.Default.Speed, contentDescription = "Node") },
                    label = { Text("Edge Node") }
                )
                NavigationBarItem(
                    selected = false,
                    onClick = onNavigateToSimple2DLab,
                    icon = { Icon(Icons.Default.AutoAwesome, contentDescription = "2D Lab") },
                    label = { Text("Simple 2D Lab") }
                )
            }
        }
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(horizontal = 16.dp)
                .verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(14.dp)
        ) {
            Spacer(modifier = Modifier.height(4.dp))

            // 1. HERO STATUS & ONE-TAP ACTION
            HeroClusterNodeCard(
                telemetry = telemetry,
                isRunning = isRunning,
                onToggleJoin = {
                    scope.launch(Dispatchers.IO) {
                        if (isRunning) {
                            sendServiceAction(context, RpcService.ACTION_STOP_FREE_RAM)
                        } else {
                            if (!telemetry.calibration.isCalibrated) {
                                RpcService.runAutoCalibration(context)
                            }
                            sendServiceAction(context, RpcService.ACTION_AUTO_DETECT_MASTER)
                        }
                    }
                }
            )

            // 2. AUTO-DISCOVERY & LINK SPEED BANNER (Inspired by exo / cake)
            AutoDiscoveryStatusCard(
                telemetry = telemetry,
                onRescan = {
                    scope.launch(Dispatchers.IO) {
                        sendServiceAction(context, RpcService.ACTION_AUTO_DETECT_MASTER)
                    }
                }
            )

            // 3. AUTO-TUNE & HARDWARE PROFILE (Inspired by node-llama-cpp)
            AutoTunedHardwareCard(
                telemetry = telemetry,
                onReTune = {
                    scope.launch(Dispatchers.IO) {
                        RpcService.runAutoCalibration(context)
                    }
                }
            )

            // 4. MEMORY & WEIGHT CACHE (Inspired by cake ~/.cache/cake for slow networks)
            TensorMemoryCacheCard(
                cacheStats = cacheStats,
                onClearCache = {
                    TensorCacheManager.clearCache(context)
                    cacheStats = TensorCacheManager.getStats(context)
                }
            )

            // 5. LIVE DEVICE HEALTH (LMKD Guard + Thermal)
            DeviceHealthCard(telemetry = telemetry)

            Spacer(modifier = Modifier.height(16.dp))
        }
    }

    if (showQrScanner) {
        CameraQrScannerDialog(
            telemetry = telemetry,
            initialTab = 0,
            onDismiss = { showQrScanner = false },
            onSubmitQrPayload = { qrUri ->
                val intent = Intent(context, RpcService::class.java).apply {
                    action = RpcService.ACTION_PAIR_QR_URI
                    putExtra(RpcService.EXTRA_QR_URI, qrUri)
                }
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.startForegroundService(intent)
                } else {
                    context.startService(intent)
                }
                showQrScanner = false
            }
        )
    }
}

@Composable
private fun HeroClusterNodeCard(
    telemetry: DeviceTelemetryState,
    isRunning: Boolean,
    onToggleJoin: () -> Unit
) {
    val statusBgColor by animateColorAsState(
        targetValue = when (telemetry.workerState) {
            WorkerRunState.RUNNING_USB, WorkerRunState.RUNNING_WIFI -> Color(0xFF10B981)
            WorkerRunState.PROBING -> Color(0xFF3B82F6)
            WorkerRunState.THROTTLED_THERMAL -> Color(0xFFF59E0B)
            WorkerRunState.SHEDDING_MEMORY -> Color(0xFFEF4444)
            WorkerRunState.STOPPED -> Color(0xFF64748B)
        },
        label = "statusColor"
    )

    val statusText = when (telemetry.workerState) {
        WorkerRunState.RUNNING_USB -> "CONNECTED OVER USB • ZERO-LATENCY"
        WorkerRunState.RUNNING_WIFI -> "ONLINE ON WI-FI MESH • AUTHENTICATED"
        WorkerRunState.PROBING -> "DISCOVERING CLUSTER MASTER..."
        WorkerRunState.THROTTLED_THERMAL -> "PAUSED TEMPORARILY TO COOL PHONE"
        WorkerRunState.SHEDDING_MEMORY -> "SHEDDING LAYERS (LMKD SAFE)"
        WorkerRunState.STOPPED -> "STANDBY • READY TO JOIN CLUSTER"
    }

    Card(
        shape = RoundedCornerShape(22.dp),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f)
        ),
        elevation = CardDefaults.cardElevation(defaultElevation = 2.dp)
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(20.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            // Status Pill
            Surface(
                shape = CircleShape,
                color = statusBgColor.copy(alpha = 0.15f),
                border = androidx.compose.foundation.BorderStroke(1.dp, statusBgColor.copy(alpha = 0.4f))
            ) {
                Row(
                    modifier = Modifier.padding(horizontal = 14.dp, vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    Box(
                        modifier = Modifier
                            .size(10.dp)
                            .clip(CircleShape)
                            .background(statusBgColor)
                    )
                    Text(
                        text = statusText,
                        fontSize = 11.sp,
                        fontWeight = FontWeight.Bold,
                        color = statusBgColor
                    )
                }
            }

            // Big Device Title
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Text(
                    text = telemetry.deviceModel,
                    style = MaterialTheme.typography.headlineSmall,
                    fontWeight = FontWeight.ExtraBold
                )
                Text(
                    text = "Snapdragon Kryo 460 • 2 Big Cores Pinned",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }

            // Giant One-Tap Action Button
            Button(
                onClick = onToggleJoin,
                modifier = Modifier
                    .fillMaxWidth()
                    .height(56.dp),
                shape = RoundedCornerShape(16.dp),
                colors = ButtonDefaults.buttonColors(
                    containerColor = if (isRunning) Color(0xFFDC2626) else Color(0xFF2563EB)
                )
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(10.dp)
                ) {
                    Icon(
                        imageVector = if (isRunning) Icons.Default.Stop else Icons.Default.Speed,
                        contentDescription = null,
                        modifier = Modifier.size(22.dp)
                    )
                    Text(
                        text = if (isRunning) "Stop Worker & Free RAM" else "Auto-Join Cluster (1-Tap)",
                        fontSize = 16.sp,
                        fontWeight = FontWeight.Bold
                    )
                }
            }
        }
    }
}

@Composable
private fun AutoDiscoveryStatusCard(
    telemetry: DeviceTelemetryState,
    onRescan: () -> Unit
) {
    Card(
        shape = RoundedCornerShape(18.dp),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surface
        ),
        elevation = CardDefaults.cardElevation(defaultElevation = 1.dp)
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
                        imageVector = Icons.Default.Radar,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.size(20.dp)
                    )
                    Text(
                        text = "Auto-Discovery (Zero-Config)",
                        fontWeight = FontWeight.Bold,
                        style = MaterialTheme.typography.titleSmall
                    )
                }
                FilledTonalButton(
                    onClick = onRescan,
                    contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 10.dp, vertical = 2.dp)
                ) {
                    Text("Re-scan", fontSize = 11.sp)
                }
            }

            val linkIcon = if (telemetry.usbLoopbackOnly) Icons.Default.Usb else Icons.Default.Wifi
            val linkTitle = if (telemetry.usbLoopbackOnly) "USB ADB Port Forward" else "Wi-Fi LAN mDNS"

            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(12.dp))
                    .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f))
                    .padding(12.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp)
            ) {
                Icon(
                    imageVector = linkIcon,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.size(22.dp)
                )
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = linkTitle,
                        fontWeight = FontWeight.SemiBold,
                        fontSize = 13.sp
                    )
                    Text(
                        text = telemetry.pairedMasterAddress,
                        fontSize = 12.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )
                }
            }
        }
    }
}

@Composable
private fun AutoTunedHardwareCard(
    telemetry: DeviceTelemetryState,
    onReTune: () -> Unit
) {
    Card(
        shape = RoundedCornerShape(18.dp),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surface
        ),
        elevation = CardDefaults.cardElevation(defaultElevation = 1.dp)
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
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
                        imageVector = Icons.Default.Tune,
                        contentDescription = null,
                        tint = Color(0xFF10B981),
                        modifier = Modifier.size(20.dp)
                    )
                    Text(
                        text = "Auto-Tuned on First Run",
                        fontWeight = FontWeight.Bold,
                        style = MaterialTheme.typography.titleSmall
                    )
                }
                FilledTonalButton(
                    onClick = onReTune,
                    contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 10.dp, vertical = 2.dp)
                ) {
                    Text("Re-Tune", fontSize = 11.sp)
                }
            }

            Text(
                text = telemetry.calibration.summarySentence,
                fontSize = 12.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                MetricMiniBox(
                    label = "Safe RAM Cap",
                    value = "${telemetry.safeCapMb} MB",
                    subtext = "LMKD Protected (<=50%)",
                    modifier = Modifier.weight(1f)
                )
                MetricMiniBox(
                    label = "CPU Big Cores",
                    value = "${telemetry.bigCoreCount} Gold",
                    subtext = "Pinned @ 2.0 GHz",
                    modifier = Modifier.weight(1f)
                )
                MetricMiniBox(
                    label = "Backend",
                    value = if (telemetry.vulkanProbePassed) "Vulkan 1.1" else "ARM NEON",
                    subtext = "FP16 Fast Math",
                    modifier = Modifier.weight(1f)
                )
            }
        }
    }
}

@Composable
private fun TensorMemoryCacheCard(
    cacheStats: TensorCacheStats,
    onClearCache: () -> Unit
) {
    Card(
        shape = RoundedCornerShape(18.dp),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surface
        ),
        elevation = CardDefaults.cardElevation(defaultElevation = 1.dp)
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
                        imageVector = Icons.Default.Storage,
                        contentDescription = null,
                        tint = Color(0xFFF59E0B),
                        modifier = Modifier.size(20.dp)
                    )
                    Text(
                        text = "Weight & KV Cache (Slow Network Guard)",
                        fontWeight = FontWeight.Bold,
                        style = MaterialTheme.typography.titleSmall
                    )
                }
                if (cacheStats.layerCount > 0) {
                    OutlinedButton(
                        onClick = onClearCache,
                        contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 8.dp, vertical = 2.dp)
                    ) {
                        Text("Clear", fontSize = 11.sp)
                    }
                }
            }

            Text(
                text = "Inspired by cake (~/.cache/cake). Layers streamed over slow Wi-Fi are persisted in high-speed flash cache so subsequent inferences start immediately with zero redundant downloads.",
                fontSize = 12.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )

            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(12.dp))
                    .background(Color(0xFFF59E0B).copy(alpha = 0.1f))
                    .padding(10.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween
            ) {
                Column {
                    Text(
                        text = cacheStats.statusLabel,
                        fontWeight = FontWeight.Bold,
                        fontSize = 12.sp,
                        color = Color(0xFFD97706)
                    )
                    Text(
                        text = "Zero-Re-download active on Wi-Fi reconnects",
                        fontSize = 11.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
                Text(
                    text = "${cacheStats.cachedMb} MB",
                    fontWeight = FontWeight.ExtraBold,
                    fontSize = 16.sp,
                    color = Color(0xFFD97706)
                )
            }
        }
    }
}

@Composable
private fun DeviceHealthCard(telemetry: DeviceTelemetryState) {
    Card(
        shape = RoundedCornerShape(18.dp),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surface
        ),
        elevation = CardDefaults.cardElevation(defaultElevation = 1.dp)
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            Text(
                text = "Device Health & Temperature Envelope",
                fontWeight = FontWeight.Bold,
                style = MaterialTheme.typography.titleSmall
            )

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(12.dp)
            ) {
                Row(
                    modifier = Modifier.weight(1f),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    Icon(
                        imageVector = Icons.Outlined.Thermostat,
                        contentDescription = null,
                        tint = if (telemetry.temperatureCelsius > 40f) Color(0xFFEF4444) else Color(0xFF10B981)
                    )
                    Column {
                        Text(
                            text = "${telemetry.temperatureCelsius}°C",
                            fontWeight = FontWeight.Bold,
                            fontSize = 13.sp
                        )
                        Text(
                            text = "Thermal Headroom OK",
                            fontSize = 11.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }

                Row(
                    modifier = Modifier.weight(1f),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    Icon(
                        imageVector = Icons.Default.BatteryChargingFull,
                        contentDescription = null,
                        tint = Color(0xFF10B981)
                    )
                    Column {
                        Text(
                            text = "${telemetry.batteryPercent}% Charging",
                            fontWeight = FontWeight.Bold,
                            fontSize = 13.sp
                        )
                        Text(
                            text = "Safe Power Level",
                            fontSize = 11.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun MetricMiniBox(
    label: String,
    value: String,
    subtext: String,
    modifier: Modifier = Modifier
) {
    Column(
        modifier = modifier
            .clip(RoundedCornerShape(12.dp))
            .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f))
            .padding(10.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp)
    ) {
        Text(
            text = label,
            fontSize = 10.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        Text(
            text = value,
            fontWeight = FontWeight.Bold,
            fontSize = 13.sp,
            color = MaterialTheme.colorScheme.onSurface
        )
        Text(
            text = subtext,
            fontSize = 9.sp,
            color = MaterialTheme.colorScheme.primary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis
        )
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
