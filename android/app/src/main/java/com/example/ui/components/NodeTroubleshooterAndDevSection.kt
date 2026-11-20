package com.example.ui.components

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Build
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Code
import androidx.compose.material.icons.filled.Error
import androidx.compose.material.icons.filled.HealthAndSafety
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material.icons.outlined.CleaningServices
import androidx.compose.material.icons.outlined.Speed
import androidx.compose.material.icons.outlined.Usb
import androidx.compose.material.icons.outlined.Wifi
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.example.service.AutoFixAction
import com.example.service.DeviceTelemetryState
import com.example.service.DiagnosticCheck
import com.example.service.DiagnosticSeverity
import com.example.service.WorkerRunState

/**
 * Plain-English Auto-Diagnosis card so a beginner with zero LLM or networking knowledge
 * can tap one button to check Wi-Fi, computer reachability, memory, battery, and calibration
 * and apply 1-tap automatic fixes.
 */
@Composable
fun AutoDiagnosisTroubleshooterCard(
    telemetry: DeviceTelemetryState,
    onRunAutoDiagnosis: () -> Unit,
    onApplyAutoFix: (AutoFixAction) -> Unit,
    modifier: Modifier = Modifier
) {
    val report = telemetry.diagnosticReport

    Card(
        modifier = modifier.fillMaxWidth(),
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
                        imageVector = Icons.Filled.HealthAndSafety,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.size(22.dp)
                    )
                    Spacer(modifier = Modifier.width(8.dp))
                    Column {
                        Text(
                            text = "Auto-Diagnosis & Fix",
                            style = MaterialTheme.typography.titleMedium,
                            fontWeight = FontWeight.Bold
                        )
                        Text(
                            text = "Having trouble? Check Wi-Fi, computer link, and phone health automatically.",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }
            }

            FilledTonalButton(
                onClick = onRunAutoDiagnosis,
                enabled = !telemetry.isDiagnosing,
                modifier = Modifier
                    .fillMaxWidth()
                    .height(48.dp)
                    .testTag("auto_diagnose_button")
            ) {
                if (telemetry.isDiagnosing) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(18.dp),
                        strokeWidth = 2.dp
                    )
                    Spacer(modifier = Modifier.width(10.dp))
                    Text("Checking Your Setup...")
                } else {
                    Icon(
                        imageVector = Icons.Filled.Build,
                        contentDescription = null,
                        modifier = Modifier.size(18.dp)
                    )
                    Spacer(modifier = Modifier.width(8.dp))
                    Text(
                        if (report == null) "Check & Fix Problems" else "Re-Run Auto-Diagnosis"
                    )
                }
            }

            AnimatedVisibility(
                visible = report != null,
                enter = fadeIn() + expandVertically(),
                exit = fadeOut() + shrinkVertically()
            ) {
                if (report != null) {
                    val bannerColor = when (report.overallStatus) {
                        DiagnosticSeverity.OK -> Color(0xFF10B981).copy(alpha = 0.14f)
                        DiagnosticSeverity.WARNING -> Color(0xFFF59E0B).copy(alpha = 0.16f)
                        DiagnosticSeverity.ISSUE -> Color(0xFFEF4444).copy(alpha = 0.15f)
                    }
                    val bannerTint = when (report.overallStatus) {
                        DiagnosticSeverity.OK -> Color(0xFF059669)
                        DiagnosticSeverity.WARNING -> Color(0xFFD97706)
                        DiagnosticSeverity.ISSUE -> Color(0xFFDC2626)
                    }

                    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Surface(
                            shape = RoundedCornerShape(14.dp),
                            color = bannerColor,
                            modifier = Modifier.fillMaxWidth()
                        ) {
                            Column(modifier = Modifier.padding(12.dp)) {
                                Text(
                                    text = report.headline,
                                    style = MaterialTheme.typography.titleSmall,
                                    fontWeight = FontWeight.Bold,
                                    color = bannerTint
                                )
                                Text(
                                    text = "${report.subtext} (Checked ${report.ranAtLabel})",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurface
                                )
                            }
                        }

                        report.checks.forEach { check ->
                            DiagnosticCheckRow(
                                check = check,
                                onApplyAutoFix = onApplyAutoFix
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun DiagnosticCheckRow(
    check: DiagnosticCheck,
    onApplyAutoFix: (AutoFixAction) -> Unit
) {
    val (icon, tint) = when (check.severity) {
        DiagnosticSeverity.OK -> Icons.Filled.CheckCircle to Color(0xFF10B981)
        DiagnosticSeverity.WARNING -> Icons.Filled.Warning to Color(0xFFF59E0B)
        DiagnosticSeverity.ISSUE -> Icons.Filled.Error to Color(0xFFEF4444)
    }

    Surface(
        shape = RoundedCornerShape(12.dp),
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.45f),
        modifier = Modifier.fillMaxWidth()
    ) {
        Column(
            modifier = Modifier.padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp)
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                Icon(
                    imageVector = icon,
                    contentDescription = check.severity.name,
                    tint = tint,
                    modifier = Modifier.size(18.dp)
                )
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = check.title,
                        style = MaterialTheme.typography.labelLarge,
                        fontWeight = FontWeight.SemiBold
                    )
                    Text(
                        text = check.statusText,
                        style = MaterialTheme.typography.labelSmall,
                        color = tint,
                        fontWeight = FontWeight.Medium
                    )
                }
            }
            Text(
                text = check.plainEnglishTip,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            if (check.fixAction != null) {
                OutlinedButton(
                    onClick = { onApplyAutoFix(check.fixAction) },
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(44.dp)
                        .testTag("auto_fix_${check.id}")
                ) {
                    Text(check.fixAction.buttonLabel)
                }
            }
        }
    }
}

/**
 * Developer Mode gate keeping ALL technical LLM/networking knobs (manual USB vs Wi-Fi bind,
 * shared HMAC cluster secret, LMKD low-memory stress test, Vulkan/ISA/16KB ELF diagnostics,
 * and raw event logs) cleanly hidden from beginners until toggled ON.
 */
@Composable
fun DeveloperModeSettingsCard(
    telemetry: DeviceTelemetryState,
    secretInput: String,
    onSecretChange: (String) -> Unit,
    onToggleDeveloperMode: (Boolean) -> Unit,
    onSelectBindMode: (Boolean) -> Unit,
    onManualStartWorker: () -> Unit,
    onSimulateTrimMemory: () -> Unit,
    modifier: Modifier = Modifier
) {
    val isRunning = telemetry.workerState == WorkerRunState.RUNNING_USB ||
        telemetry.workerState == WorkerRunState.RUNNING_WIFI ||
        telemetry.workerState == WorkerRunState.THROTTLED_THERMAL

    Card(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(20.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        elevation = CardDefaults.cardElevation(defaultElevation = 2.dp)
    ) {
        Column(modifier = Modifier.padding(18.dp)) {
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
                        imageVector = Icons.Filled.Code,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.size(20.dp)
                    )
                    Spacer(modifier = Modifier.width(10.dp))
                    Column {
                        Text(
                            text = "Developer Mode",
                            style = MaterialTheme.typography.titleSmall,
                            fontWeight = FontWeight.Bold
                        )
                        Text(
                            text = "Advanced network bind, security key, memory tests & raw logs",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }
                Switch(
                    checked = telemetry.developerModeEnabled,
                    onCheckedChange = onToggleDeveloperMode,
                    modifier = Modifier.testTag("developer_mode_switch")
                )
            }

            AnimatedVisibility(
                visible = telemetry.developerModeEnabled,
                enter = fadeIn() + expandVertically(),
                exit = fadeOut() + shrinkVertically()
            ) {
                Column(
                    modifier = Modifier.padding(top = 14.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp)
                ) {
                    HorizontalDivider(color = MaterialTheme.colorScheme.outline.copy(alpha = 0.2f))

                    Text(
                        text = "Manual Transport & Bind Mode",
                        style = MaterialTheme.typography.labelLarge,
                        fontWeight = FontWeight.SemiBold
                    )
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(8.dp)
                    ) {
                        FilterChip(
                            selected = telemetry.usbLoopbackOnly,
                            onClick = { onSelectBindMode(true) },
                            label = { Text("USB Cable (127.0.0.1)") },
                            leadingIcon = {
                                Icon(
                                    imageVector = Icons.Outlined.Usb,
                                    contentDescription = null,
                                    modifier = Modifier.size(18.dp)
                                )
                            },
                            modifier = Modifier.testTag("bind_mode_usb_chip")
                        )
                        FilterChip(
                            selected = !telemetry.usbLoopbackOnly,
                            onClick = { onSelectBindMode(false) },
                            label = { Text("Wi-Fi LAN (Auth)") },
                            leadingIcon = {
                                Icon(
                                    imageVector = Icons.Outlined.Wifi,
                                    contentDescription = null,
                                    modifier = Modifier.size(18.dp)
                                )
                            },
                            modifier = Modifier.testTag("bind_mode_wifi_chip")
                        )
                    }

                    if (!telemetry.usbLoopbackOnly) {
                        OutlinedTextField(
                            value = secretInput,
                            onValueChange = onSecretChange,
                            label = { Text("Cluster Shared Secret (32-Byte Auth Token)") },
                            singleLine = true,
                            modifier = Modifier
                                .fillMaxWidth()
                                .testTag("cluster_secret_input")
                        )
                    }

                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(8.dp)
                    ) {
                        Button(
                            onClick = onManualStartWorker,
                            enabled = !isRunning,
                            modifier = Modifier
                                .weight(1f)
                                .testTag("start_rpc_worker_button")
                        ) {
                            Icon(imageVector = Icons.Filled.PlayArrow, contentDescription = null)
                            Spacer(modifier = Modifier.width(6.dp))
                            Text("Start Raw Worker")
                        }
                    }

                    FilledTonalButton(
                        onClick = onSimulateTrimMemory,
                        modifier = Modifier
                            .fillMaxWidth()
                            .testTag("simulate_trim_memory_button")
                    ) {
                        Icon(imageVector = Icons.Outlined.CleaningServices, contentDescription = null)
                        Spacer(modifier = Modifier.width(8.dp))
                        Text("Simulate Android Low-Memory (SHED_LAYERS)")
                    }

                    Surface(
                        shape = RoundedCornerShape(12.dp),
                        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f),
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Column(
                            modifier = Modifier.padding(12.dp),
                            verticalArrangement = Arrangement.spacedBy(4.dp)
                        ) {
                            Text(
                                text = "Hardware & Protocol Telemetry",
                                style = MaterialTheme.typography.labelMedium,
                                fontWeight = FontWeight.Bold
                            )
                            Text(
                                text = "Bind: ${telemetry.bindAddress} • Handshakes: ${telemetry.handshakesCompleted}\n" +
                                    "Benchmark: ${telemetry.calibration.performanceScore}/100 (${telemetry.calibration.benchmarkDurationMs}ms) • Threads: -t ${telemetry.bigCoreCount}/${telemetry.totalCoreCount}\n" +
                                    "RAM Cap: ${telemetry.safeCapMb} MB / ${telemetry.totalRamMb} MB (<=50%) • Layers: ${telemetry.activeLayersAssigned}\n" +
                                    "Vulkan: ${telemetry.vulkanDeviceName}\n" +
                                    "CPU ISA: ${telemetry.cpuFeatures} • API ${telemetry.apiLevel} • 16KB ELF Ready",
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                    }

                    DeveloperEventLogSection(logs = telemetry.eventLogs)
                }
            }
        }
    }
}

@Composable
private fun DeveloperEventLogSection(logs: List<String>) {
    Column {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(
                imageVector = Icons.Outlined.Speed,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.primary,
                modifier = Modifier.size(16.dp)
            )
            Spacer(modifier = Modifier.width(6.dp))
            Text(
                text = "Raw Node Event Log",
                style = MaterialTheme.typography.labelMedium,
                fontWeight = FontWeight.Bold
            )
        }
        Spacer(modifier = Modifier.height(6.dp))
        if (logs.isEmpty()) {
            Text(
                text = "No events recorded yet.",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        } else {
            logs.take(10).forEach { entry ->
                Text(
                    text = entry,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(vertical = 2.dp)
                )
            }
        }
    }
}
