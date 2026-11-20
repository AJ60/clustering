package com.example.ui.components

import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.compose.foundation.background
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
import androidx.compose.material.icons.filled.CameraAlt
import androidx.compose.material.icons.filled.Memory
import androidx.compose.material.icons.filled.QrCode2
import androidx.compose.material.icons.filled.Radar
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.outlined.Thermostat
import androidx.compose.material.icons.outlined.Tune
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.example.service.AutoFixAction
import com.example.service.DeviceTelemetryState
import com.example.service.RpcService
import com.example.service.WorkerRunState
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@Composable
fun HardenedNodeDashboard(
    modifier: Modifier = Modifier,
    developerModeEnabled: Boolean = false,
    onToggleDeveloperMode: (Boolean) -> Unit = { RpcService.setDeveloperMode(it) }
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val telemetry by RpcService.telemetry.collectAsStateWithLifecycle()
    val effectiveDevMode = developerModeEnabled || telemetry.developerModeEnabled
    var secretInput by remember(telemetry.clusterSecret) { mutableStateOf(telemetry.clusterSecret) }
    var showQrModal by remember { mutableStateOf(false) }
    var qrModalInitialTab by remember { mutableIntStateOf(0) }

    // Automatically calibrate & optimize this phone on first visit so beginners never touch settings
    LaunchedEffect(Unit) {
        scope.launch(Dispatchers.IO) {
            if (!RpcService.telemetry.value.calibration.isCalibrated) {
                RpcService.runAutoCalibration(context)
            } else {
                RpcService.refreshStaticHardwareSnapshot(context)
            }
        }
    }

    Column(
        modifier = modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(14.dp)
    ) {
        // 1. ZERO-JARGON HERO: Connect Phone in 1 Tap (Auto-Connect or Scan QR)
        EasyConnectHeroCard(
            telemetry = telemetry,
            onAutoConnect = {
                scope.launch(Dispatchers.IO) {
                    if (!RpcService.telemetry.value.calibration.isCalibrated) {
                        RpcService.runAutoCalibration(context)
                    }
                    startRpcServiceAction(
                        context = context,
                        action = RpcService.ACTION_AUTO_DETECT_MASTER,
                        usbOnly = telemetry.usbLoopbackOnly,
                        secret = secretInput
                    )
                }
            },
            onScanQrCode = {
                qrModalInitialTab = 0
                showQrModal = true
            },
            onShowMyQr = {
                qrModalInitialTab = 1
                showQrModal = true
            },
            onStopSharing = {
                startRpcServiceAction(
                    context = context,
                    action = RpcService.ACTION_STOP_FREE_RAM,
                    usbOnly = telemetry.usbLoopbackOnly,
                    secret = secretInput
                )
            }
        )

        // 2. AUTO-CALIBRATION & COMFORT SUMMARY (Always auto-optimized; manual Re-Tune only in Developer Mode)
        AutoCalibratedHealthCard(
            telemetry = telemetry,
            showManualRetune = effectiveDevMode,
            onRecalibrate = {
                scope.launch(Dispatchers.IO) {
                    RpcService.runAutoCalibration(context)
                }
            }
        )

        // 3. ONE-TAP AUTO-DIAGNOSIS & AUTO-FIX TROUBLESHOOTER
        AutoDiagnosisTroubleshooterCard(
            telemetry = telemetry,
            onRunAutoDiagnosis = {
                scope.launch(Dispatchers.IO) {
                    RpcService.runAutoDiagnostics(context)
                }
            },
            onApplyAutoFix = { fix ->
                scope.launch(Dispatchers.IO) {
                    when (fix) {
                        AutoFixAction.AUTO_DETECT_MASTER -> {
                            startRpcServiceAction(
                                context = context,
                                action = RpcService.ACTION_AUTO_DETECT_MASTER,
                                usbOnly = telemetry.usbLoopbackOnly,
                                secret = secretInput
                            )
                        }
                        AutoFixAction.RECALIBRATE_DEVICE -> {
                            RpcService.runAutoCalibration(context)
                        }
                        AutoFixAction.START_SHARING -> {
                            if (!RpcService.telemetry.value.calibration.isCalibrated) {
                                RpcService.runAutoCalibration(context)
                            }
                            startRpcServiceAction(
                                context = context,
                                action = RpcService.ACTION_START_WORKER,
                                usbOnly = telemetry.usbLoopbackOnly,
                                secret = secretInput
                            )
                        }
                        AutoFixAction.SWITCH_TO_USB_SAFE_MODE -> {
                            startRpcServiceAction(
                                context = context,
                                action = RpcService.ACTION_TOGGLE_BIND_MODE,
                                usbOnly = true,
                                secret = secretInput
                            )
                        }
                        AutoFixAction.FREE_MEMORY_AND_RESTART -> {
                            RpcService.runAutoCalibration(context)
                            startRpcServiceAction(
                                context = context,
                                action = RpcService.ACTION_START_WORKER,
                                usbOnly = telemetry.usbLoopbackOnly,
                                secret = secretInput
                            )
                        }
                    }
                    delay(450L)
                    RpcService.runAutoDiagnostics(context)
                }
            }
        )

        // 4. ADVANCED WORKER CONTROLS — Completely hidden until Developer Mode is toggled ON
        if (effectiveDevMode) {
            DeveloperModeSettingsCard(
                telemetry = telemetry,
                secretInput = secretInput,
                onSecretChange = { secretInput = it },
                onToggleDeveloperMode = onToggleDeveloperMode,
                onSelectBindMode = { usbOnly ->
                    startRpcServiceAction(
                        context = context,
                        action = RpcService.ACTION_TOGGLE_BIND_MODE,
                        usbOnly = usbOnly,
                        secret = secretInput
                    )
                },
                onManualStartWorker = {
                    startRpcServiceAction(
                        context = context,
                        action = RpcService.ACTION_START_WORKER,
                        usbOnly = telemetry.usbLoopbackOnly,
                        secret = secretInput
                    )
                },
                onSimulateTrimMemory = {
                    startRpcServiceAction(
                        context = context,
                        action = RpcService.ACTION_SIMULATE_TRIM,
                        usbOnly = telemetry.usbLoopbackOnly,
                        secret = secretInput
                    )
                }
            )
        }

        Spacer(modifier = Modifier.height(20.dp))
    }

    if (showQrModal) {
        CameraQrScannerDialog(
            telemetry = telemetry,
            initialTab = qrModalInitialTab,
            onDismiss = { showQrModal = false },
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
                showQrModal = false
            }
        )
    }
}

private fun startRpcServiceAction(
    context: Context,
    action: String,
    usbOnly: Boolean,
    secret: String
) {
    val intent = Intent(context, RpcService::class.java).apply {
        this.action = action
        putExtra(RpcService.EXTRA_USB_ONLY, usbOnly)
        putExtra(RpcService.EXTRA_CLUSTER_SECRET, secret)
    }
    if ((action == RpcService.ACTION_START_WORKER || action == RpcService.ACTION_AUTO_DETECT_MASTER) &&
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
    ) {
        context.startForegroundService(intent)
    } else {
        context.startService(intent)
    }
}

@Composable
private fun EasyConnectHeroCard(
    telemetry: DeviceTelemetryState,
    onAutoConnect: () -> Unit,
    onScanQrCode: () -> Unit,
    onShowMyQr: () -> Unit,
    onStopSharing: () -> Unit
) {
    val isActive = telemetry.workerState == WorkerRunState.RUNNING_USB ||
        telemetry.workerState == WorkerRunState.RUNNING_WIFI ||
        telemetry.workerState == WorkerRunState.THROTTLED_THERMAL

    val (statusTitle, statusDotColor) = when (telemetry.workerState) {
        WorkerRunState.RUNNING_USB, WorkerRunState.RUNNING_WIFI ->
            "Sharing Power Safely" to Color(0xFF10B981)
        WorkerRunState.THROTTLED_THERMAL ->
            "Paused to Keep Phone Cool" to Color(0xFFF59E0B)
        WorkerRunState.SHEDDING_MEMORY ->
            "Paused to Keep Apps Fast" to Color(0xFFEF4444)
        WorkerRunState.PROBING ->
            "Getting Ready..." to MaterialTheme.colorScheme.primary
        WorkerRunState.STOPPED ->
            "Ready to Connect" to MaterialTheme.colorScheme.outline
    }

    val friendlyComputerText = when {
        telemetry.pairedMasterAddress.startsWith("Not Paired") ->
            "Not connected yet — open ClusterLab on your computer"
        telemetry.pairedMasterAddress.startsWith("USB ADB") ->
            "USB Cable Ready — plug into your computer"
        else -> telemetry.pairedMasterAddress
    }

    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(22.dp),
        colors = CardDefaults.cardColors(containerColor = Color.Transparent),
        elevation = CardDefaults.cardElevation(defaultElevation = 0.dp)
    ) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .background(
                    Brush.linearGradient(
                        colors = listOf(
                            MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.72f),
                            MaterialTheme.colorScheme.secondaryContainer.copy(alpha = 0.45f)
                        )
                    )
                )
                .padding(18.dp)
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Surface(
                        shape = RoundedCornerShape(50),
                        color = MaterialTheme.colorScheme.surface.copy(alpha = 0.88f)
                    ) {
                        Row(
                            modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(8.dp)
                        ) {
                            Box(
                                modifier = Modifier
                                    .size(10.dp)
                                    .clip(CircleShape)
                                    .background(statusDotColor)
                            )
                            Text(
                                text = statusTitle,
                                style = MaterialTheme.typography.labelLarge,
                                fontWeight = FontWeight.Bold
                            )
                        }
                    }

                    TextButton(
                        onClick = onShowMyQr,
                        modifier = Modifier.testTag("show_my_node_qr_button")
                    ) {
                        Icon(
                            imageVector = Icons.Filled.QrCode2,
                            contentDescription = "Show this phone's QR code",
                            modifier = Modifier.size(18.dp)
                        )
                        Spacer(modifier = Modifier.width(4.dp))
                        Text("My QR")
                    }
                }

                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(
                        text = "Connect This Phone to Your Cluster",
                        style = MaterialTheme.typography.titleLarge,
                        fontWeight = FontWeight.Bold
                    )
                    Text(
                        text = "Tap Auto-Connect or point your camera at the QR code on your Windows or Linux computer. Everything else tunes itself automatically.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }

                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(10.dp)
                ) {
                    Button(
                        onClick = onAutoConnect,
                        enabled = !telemetry.isScanningMaster,
                        modifier = Modifier
                            .weight(1.1f)
                            .height(50.dp)
                            .testTag("auto_detect_master_button")
                    ) {
                        Icon(imageVector = Icons.Filled.Radar, contentDescription = null)
                        Spacer(modifier = Modifier.width(6.dp))
                        Text(if (telemetry.isScanningMaster) "Finding PC..." else "Auto-Connect")
                    }

                    OutlinedButton(
                        onClick = onScanQrCode,
                        modifier = Modifier
                            .weight(1f)
                            .height(50.dp)
                            .testTag("pair_qr_code_button")
                    ) {
                        Icon(imageVector = Icons.Filled.CameraAlt, contentDescription = null)
                        Spacer(modifier = Modifier.width(6.dp))
                        Text("Scan QR")
                    }
                }

                if (isActive) {
                    Button(
                        onClick = onStopSharing,
                        colors = ButtonDefaults.buttonColors(
                            containerColor = MaterialTheme.colorScheme.error,
                            contentColor = MaterialTheme.colorScheme.onError
                        ),
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(48.dp)
                            .testTag("stop_free_ram_button")
                    ) {
                        Icon(imageVector = Icons.Filled.Stop, contentDescription = null)
                        Spacer(modifier = Modifier.width(8.dp))
                        Text("Stop Sharing & Free Memory")
                    }
                }

                Surface(
                    shape = RoundedCornerShape(12.dp),
                    color = MaterialTheme.colorScheme.surface.copy(alpha = 0.85f),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Column(modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp)) {
                        Text(
                            text = "Computer Status",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                        Text(
                            text = friendlyComputerText,
                            style = MaterialTheme.typography.bodyMedium,
                            fontWeight = FontWeight.SemiBold,
                            color = MaterialTheme.colorScheme.primary
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun AutoCalibratedHealthCard(
    telemetry: DeviceTelemetryState,
    showManualRetune: Boolean,
    onRecalibrate: () -> Unit
) {
    val cal = telemetry.calibration
    val ramGbText = if (telemetry.safeCapMb >= 1024L) {
        "${"%.1f".format(telemetry.safeCapMb / 1024f)} GB"
    } else {
        "${telemetry.safeCapMb} MB"
    }
    val ramRatio = if (telemetry.totalRamMb > 0L) {
        (telemetry.safeCapMb.toFloat() / telemetry.totalRamMb.toFloat()).coerceIn(0f, 1f)
    } else 0.5f

    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(20.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        elevation = CardDefaults.cardElevation(defaultElevation = 2.dp)
    ) {
        Column(
            modifier = Modifier.padding(18.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier.weight(1f)
                ) {
                    Icon(
                        imageVector = Icons.Filled.AutoAwesome,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.size(20.dp)
                    )
                    Spacer(modifier = Modifier.width(8.dp))
                    Column {
                        Text(
                            text = if (cal.isCalibrated) "Auto-Optimized • ${cal.tierLabel}" else "Auto-Optimizing Phone...",
                            style = MaterialTheme.typography.titleSmall,
                            fontWeight = FontWeight.Bold
                        )
                        Text(
                            text = cal.recommendedBackendLabel,
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.primary
                        )
                    }
                }

                if (showManualRetune) {
                    FilledTonalButton(
                        onClick = onRecalibrate,
                        enabled = !cal.isCalibrating,
                        modifier = Modifier
                            .height(48.dp)
                            .testTag("auto_calibrate_button")
                    ) {
                        if (cal.isCalibrating) {
                            CircularProgressIndicator(
                                modifier = Modifier.size(16.dp),
                                strokeWidth = 2.dp
                            )
                        } else {
                            Icon(
                                imageVector = Icons.Outlined.Tune,
                                contentDescription = "Auto-tune phone",
                                modifier = Modifier.size(16.dp)
                            )
                            Spacer(modifier = Modifier.width(6.dp))
                            Text("Re-Tune")
                        }
                    }
                }
            }

            Text(
                text = cal.summarySentence,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                FriendlyMetricPill(
                    icon = Icons.Filled.Memory,
                    label = "MEMORY CAP",
                    value = ramGbText,
                    subtext = "Always <= 50%",
                    modifier = Modifier.weight(1f)
                )
                FriendlyMetricPill(
                    icon = Icons.Outlined.Thermostat,
                    label = "PHONE HEAT",
                    value = "${"%.0f".format(telemetry.temperatureCelsius)}°C",
                    subtext = if (telemetry.temperatureCelsius < 40f) "Cool & safe" else "Warming up",
                    modifier = Modifier.weight(1f)
                )
                FriendlyMetricPill(
                    icon = Icons.Filled.BatteryChargingFull,
                    label = "BATTERY",
                    value = "${telemetry.batteryPercent}%",
                    subtext = if (telemetry.isPluggedIn) "Charging" else "Protected",
                    modifier = Modifier.weight(1f)
                )
            }

            LinearProgressIndicator(
                progress = { ramRatio },
                modifier = Modifier
                    .fillMaxWidth()
                    .height(6.dp)
                    .clip(RoundedCornerShape(3.dp)),
                color = MaterialTheme.colorScheme.primary,
                trackColor = MaterialTheme.colorScheme.surfaceVariant
            )
        }
    }
}

@Composable
private fun FriendlyMetricPill(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    label: String,
    value: String,
    subtext: String,
    modifier: Modifier = Modifier
) {
    Surface(
        modifier = modifier,
        shape = RoundedCornerShape(14.dp),
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.55f)
    ) {
        Column(modifier = Modifier.padding(10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(
                    imageVector = icon,
                    contentDescription = null,
                    modifier = Modifier.size(14.dp),
                    tint = MaterialTheme.colorScheme.primary
                )
                Spacer(modifier = Modifier.width(4.dp))
                Text(
                    text = label,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
            Spacer(modifier = Modifier.height(3.dp))
            Text(
                text = value,
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold
            )
            Text(
                text = subtext,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}
