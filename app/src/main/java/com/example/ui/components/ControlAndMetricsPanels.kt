package com.example.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Bolt
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Replay
import androidx.compose.material.icons.filled.SkipNext
import androidx.compose.material.icons.outlined.AddCircleOutline
import androidx.compose.material.icons.outlined.AutoFixHigh
import androidx.compose.material.icons.outlined.Backspace
import androidx.compose.material.icons.outlined.Brush
import androidx.compose.material.icons.outlined.DeleteSweep
import androidx.compose.material.icons.outlined.PanTool
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.FilledTonalIconButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Slider
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.example.R
import com.example.model.AlgorithmType
import com.example.model.CanvasToolMode
import com.example.model.ClusterSummary
import com.example.model.ClusteringStepFrame
import com.example.model.DbscanConfig
import com.example.model.KMeansConfig
import com.example.model.PresetDatasetType
import com.example.ui.theme.ClusterColors
import com.example.ui.theme.NoisePointColor

@Composable
fun CanvasToolbarAndPlaybackBar(
    toolMode: CanvasToolMode,
    isPlaying: Boolean,
    currentFrameIndex: Int,
    totalFrames: Int,
    stepDescription: String,
    isConverged: Boolean,
    onSelectTool: (CanvasToolMode) -> Unit,
    onTogglePlay: () -> Unit,
    onStepForward: () -> Unit,
    onReset: () -> Unit,
    onConvergeInstant: () -> Unit,
    onClearCanvas: () -> Unit,
    modifier: Modifier = Modifier,
    developerModeEnabled: Boolean = false,
    onRunClustering: () -> Unit = onTogglePlay,
    gestureToolsModifier: Modifier = Modifier,
    runButtonModifier: Modifier = Modifier
) {
    val visibleTools = if (developerModeEnabled) {
        CanvasToolMode.entries
    } else {
        listOf(CanvasToolMode.ADD, CanvasToolMode.ERASE)
    }

    Card(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(18.dp),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.65f)
        )
    ) {
        Column(modifier = Modifier.padding(12.dp)) {
            // Primary Row: Gesture Tools (Tap Add, Erase, Clear) + Prominent Run Clustering Button
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Row(
                    modifier = gestureToolsModifier
                        .weight(1f)
                        .horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    visibleTools.forEach { mode ->
                        val selected = toolMode == mode
                        val icon = when (mode) {
                            CanvasToolMode.ADD -> Icons.Outlined.AddCircleOutline
                            CanvasToolMode.BRUSH -> Icons.Outlined.Brush
                            CanvasToolMode.ERASE -> Icons.Outlined.Backspace
                            CanvasToolMode.PAN -> Icons.Outlined.PanTool
                        }
                        FilterChip(
                            selected = selected,
                            onClick = { onSelectTool(mode) },
                            label = { Text(mode.label, style = MaterialTheme.typography.labelLarge) },
                            leadingIcon = {
                                Icon(
                                    imageVector = icon,
                                    contentDescription = mode.label,
                                    modifier = Modifier.size(18.dp)
                                )
                            },
                            modifier = Modifier.testTag("tool_chip_${mode.name.lowercase()}")
                        )
                    }

                    AssistChip(
                        onClick = onClearCanvas,
                        label = { Text(stringResource(R.string.action_clear_points)) },
                        leadingIcon = {
                            Icon(
                                imageVector = Icons.Outlined.DeleteSweep,
                                contentDescription = stringResource(R.string.action_clear_points),
                                modifier = Modifier.size(18.dp)
                            )
                        },
                        modifier = Modifier.testTag("clear_canvas_chip")
                    )
                }

                Button(
                    onClick = { if (isPlaying) onTogglePlay() else onRunClustering() },
                    modifier = runButtonModifier
                        .heightIn(min = 48.dp)
                        .testTag("run_clustering_button")
                ) {
                    Icon(
                        imageVector = if (isPlaying) Icons.Filled.Pause else Icons.Filled.PlayArrow,
                        contentDescription = if (isPlaying) {
                            stringResource(R.string.action_pause)
                        } else {
                            stringResource(R.string.action_run_clustering)
                        },
                        modifier = Modifier.size(18.dp)
                    )
                    Spacer(modifier = Modifier.width(4.dp))
                    Text(
                        text = if (isPlaying) {
                            stringResource(R.string.action_pause)
                        } else {
                            stringResource(R.string.action_run_clustering)
                        },
                        style = MaterialTheme.typography.labelLarge
                    )
                }
            }

            if (developerModeEnabled) {
                Spacer(modifier = Modifier.height(8.dp))

                // Advanced Playback Transport & Step Progress Row (Developer Mode)
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween
                ) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(6.dp)
                    ) {
                        FilledIconButton(
                            onClick = onTogglePlay,
                            modifier = Modifier
                                .size(48.dp)
                                .testTag("play_pause_button")
                        ) {
                            Icon(
                                imageVector = if (isPlaying) Icons.Filled.Pause else Icons.Filled.PlayArrow,
                                contentDescription = if (isPlaying) {
                                    stringResource(R.string.action_pause)
                                } else {
                                    stringResource(R.string.action_play)
                                }
                            )
                        }

                        FilledTonalIconButton(
                            onClick = onStepForward,
                            modifier = Modifier
                                .size(48.dp)
                                .testTag("step_forward_button")
                        ) {
                            Icon(
                                imageVector = Icons.Filled.SkipNext,
                                contentDescription = stringResource(R.string.action_step)
                            )
                        }

                        FilledTonalIconButton(
                            onClick = onReset,
                            modifier = Modifier
                                .size(48.dp)
                                .testTag("reset_steps_button")
                        ) {
                            Icon(
                                imageVector = Icons.Filled.Replay,
                                contentDescription = stringResource(R.string.action_reset)
                            )
                        }
                    }

                    FilledTonalButton(
                        onClick = onConvergeInstant,
                        modifier = Modifier.testTag("converge_instant_button")
                    ) {
                        Icon(
                            imageVector = Icons.Filled.Bolt,
                            contentDescription = null,
                            modifier = Modifier.size(16.dp)
                        )
                        Spacer(modifier = Modifier.width(4.dp))
                        Text(
                            text = "${currentFrameIndex + 1}/$totalFrames",
                            style = MaterialTheme.typography.labelMedium
                        )
                    }
                }

                Spacer(modifier = Modifier.height(6.dp))

                // Step Status Line
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween
                ) {
                    Text(
                        text = stepDescription,
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f)
                    )
                    if (isConverged) {
                        Spacer(modifier = Modifier.width(8.dp))
                        Surface(
                            shape = RoundedCornerShape(8.dp),
                            color = MaterialTheme.colorScheme.secondaryContainer
                        ) {
                            Text(
                                text = "CONVERGED",
                                style = MaterialTheme.typography.labelSmall,
                                fontWeight = FontWeight.Bold,
                                color = MaterialTheme.colorScheme.onSecondaryContainer,
                                modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp)
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun AlgorithmAndHyperparametersCard(
    algorithm: AlgorithmType,
    kMeansConfig: KMeansConfig,
    dbscanConfig: DbscanConfig,
    onSelectAlgorithm: (AlgorithmType) -> Unit,
    onUpdateK: (Int) -> Unit,
    onToggleKMeansPlusPlus: (Boolean) -> Unit,
    onToggleVoronoi: (Boolean) -> Unit,
    onToggleTrails: (Boolean) -> Unit,
    onUpdateEpsilon: (Float) -> Unit,
    onUpdateMinPts: (Int) -> Unit,
    onToggleEpsilonRings: (Boolean) -> Unit,
    modifier: Modifier = Modifier,
    developerModeEnabled: Boolean = false
) {
    Card(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(18.dp),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surface
        ),
        elevation = CardDefaults.cardElevation(defaultElevation = 2.dp)
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            // Segmented Algorithm Switcher
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(10.dp)
            ) {
                AlgorithmType.entries.forEach { type ->
                    val isSelected = algorithm == type
                    FilterChip(
                        selected = isSelected,
                        onClick = { onSelectAlgorithm(type) },
                        label = {
                            Text(
                                text = type.displayName,
                                style = MaterialTheme.typography.titleSmall,
                                modifier = Modifier.padding(vertical = 4.dp)
                            )
                        },
                        leadingIcon = {
                            Icon(
                                imageVector = Icons.Outlined.AutoFixHigh,
                                contentDescription = null,
                                modifier = Modifier.size(18.dp)
                            )
                        },
                        modifier = Modifier
                            .weight(1f)
                            .testTag("algo_tab_${type.name.lowercase()}")
                    )
                }
            }

            Spacer(modifier = Modifier.height(12.dp))

            if (algorithm == AlgorithmType.KMEANS) {
                // Essential K-Means Slider
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(
                        text = stringResource(R.string.label_clusters_k),
                        style = MaterialTheme.typography.labelLarge
                    )
                    Text(
                        text = "K = ${kMeansConfig.k}",
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.primary,
                        fontWeight = FontWeight.Bold
                    )
                }
                Slider(
                    value = kMeansConfig.k.toFloat(),
                    onValueChange = { onUpdateK(it.toInt()) },
                    valueRange = 2f..10f,
                    steps = 7,
                    modifier = Modifier.testTag("slider_kmeans_k")
                )

                if (developerModeEnabled) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Text(
                            text = stringResource(R.string.label_kmeans_plus_plus),
                            style = MaterialTheme.typography.bodyMedium
                        )
                        Switch(
                            checked = kMeansConfig.useKMeansPlusPlus,
                            onCheckedChange = onToggleKMeansPlusPlus,
                            modifier = Modifier.testTag("switch_kmeans_plus_plus")
                        )
                    }

                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(8.dp)
                    ) {
                        FilterChip(
                            selected = kMeansConfig.showVoronoi,
                            onClick = { onToggleVoronoi(!kMeansConfig.showVoronoi) },
                            label = { Text(stringResource(R.string.label_show_voronoi)) },
                            modifier = Modifier.testTag("chip_toggle_voronoi")
                        )
                        FilterChip(
                            selected = kMeansConfig.showTrails,
                            onClick = { onToggleTrails(!kMeansConfig.showTrails) },
                            label = { Text(stringResource(R.string.label_show_trails)) },
                            modifier = Modifier.testTag("chip_toggle_trails")
                        )
                    }
                }
            } else {
                // Essential DBSCAN Radius Slider
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(
                        text = stringResource(R.string.label_epsilon),
                        style = MaterialTheme.typography.labelLarge
                    )
                    Text(
                        text = "ε = ${"%.3f".format(dbscanConfig.epsilon)}",
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.primary,
                        fontWeight = FontWeight.Bold
                    )
                }
                Slider(
                    value = dbscanConfig.epsilon,
                    onValueChange = onUpdateEpsilon,
                    valueRange = 0.025f..0.22f,
                    modifier = Modifier.testTag("slider_dbscan_epsilon")
                )

                if (developerModeEnabled) {
                    Spacer(modifier = Modifier.height(4.dp))

                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Text(
                            text = stringResource(R.string.label_min_pts),
                            style = MaterialTheme.typography.labelLarge
                        )
                        Text(
                            text = "MinPts = ${dbscanConfig.minPts}",
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.primary,
                            fontWeight = FontWeight.Bold
                        )
                    }
                    Slider(
                        value = dbscanConfig.minPts.toFloat(),
                        onValueChange = { onUpdateMinPts(it.toInt()) },
                        valueRange = 2f..15f,
                        steps = 12,
                        modifier = Modifier.testTag("slider_dbscan_minpts")
                    )

                    FilterChip(
                        selected = dbscanConfig.showEpsilonRings,
                        onClick = { onToggleEpsilonRings(!dbscanConfig.showEpsilonRings) },
                        label = { Text(stringResource(R.string.label_show_eps_rings)) },
                        modifier = Modifier.testTag("chip_toggle_eps_rings")
                    )
                }
            }
        }
    }
}

@Composable
fun PresetDatasetSelectorCard(
    selectedPreset: PresetDatasetType,
    sampleCount: Int,
    noiseSpread: Float,
    onSelectPreset: (PresetDatasetType) -> Unit,
    onUpdateSampleCount: (Int) -> Unit,
    onUpdateNoiseSpread: (Float) -> Unit,
    modifier: Modifier = Modifier,
    developerModeEnabled: Boolean = false
) {
    Card(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(18.dp),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surface
        ),
        elevation = CardDefaults.cardElevation(defaultElevation = 2.dp)
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Text(
                text = stringResource(R.string.label_presets),
                style = MaterialTheme.typography.titleSmall,
                color = MaterialTheme.colorScheme.onSurface
            )
            Spacer(modifier = Modifier.height(8.dp))

            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                PresetDatasetType.entries.forEach { preset ->
                    FilterChip(
                        selected = selectedPreset == preset,
                        onClick = { onSelectPreset(preset) },
                        label = { Text(preset.title) },
                        modifier = Modifier.testTag("preset_chip_${preset.name.lowercase()}")
                    )
                }
            }

            if (developerModeEnabled) {
                Spacer(modifier = Modifier.height(10.dp))

                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween
                ) {
                    Text(
                        text = "Sample Points: $sampleCount",
                        style = MaterialTheme.typography.labelMedium
                    )
                    Text(
                        text = "Scatter Noise: ${"%.3f".format(noiseSpread)}",
                        style = MaterialTheme.typography.labelMedium
                    )
                }

                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(12.dp)
                ) {
                    Slider(
                        value = sampleCount.toFloat(),
                        onValueChange = { onUpdateSampleCount(it.toInt()) },
                        valueRange = 50f..300f,
                        modifier = Modifier
                            .weight(1f)
                            .testTag("slider_sample_count")
                    )
                    Slider(
                        value = noiseSpread,
                        onValueChange = onUpdateNoiseSpread,
                        valueRange = 0.012f..0.08f,
                        modifier = Modifier
                            .weight(1f)
                            .testTag("slider_noise_spread")
                    )
                }
            }
        }
    }
}

@Composable
fun MetricsInspectorCard(
    algorithm: AlgorithmType,
    frame: ClusteringStepFrame?,
    modifier: Modifier = Modifier
) {
    Card(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(18.dp),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surface
        ),
        elevation = CardDefaults.cardElevation(defaultElevation = 2.dp)
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Text(
                text = stringResource(R.string.label_metrics),
                style = MaterialTheme.typography.titleSmall,
                color = MaterialTheme.colorScheme.onSurface
            )
            Spacer(modifier = Modifier.height(12.dp))

            val summaries = frame?.clusterSummaries.orEmpty()
            val wcss = frame?.wcss ?: 0f
            val silhouette = frame?.silhouetteScore ?: 0f
            val coreCnt = frame?.coreCount ?: 0
            val borderCnt = frame?.borderCount ?: 0
            val noiseCnt = frame?.noiseCount ?: 0

            // Top KPI Pills
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                MetricPill(
                    label = "CLUSTERS",
                    value = "${summaries.size}",
                    modifier = Modifier.weight(1f)
                )
                MetricPill(
                    label = if (algorithm == AlgorithmType.KMEANS) "INERTIA (WCSS)" else "CORE / BORDER",
                    value = if (algorithm == AlgorithmType.KMEANS) {
                        "%.3f".format(wcss)
                    } else {
                        "$coreCnt / $borderCnt"
                    },
                    modifier = Modifier.weight(1f)
                )
                MetricPill(
                    label = if (algorithm == AlgorithmType.KMEANS) "SILHOUETTE" else "OUTLIERS (X)",
                    value = if (algorithm == AlgorithmType.KMEANS) {
                        "%.2f".format(silhouette)
                    } else {
                        "$noiseCnt"
                    },
                    modifier = Modifier.weight(1f)
                )
            }

            if (summaries.isNotEmpty()) {
                Spacer(modifier = Modifier.height(12.dp))
                HorizontalDivider(color = MaterialTheme.colorScheme.outline.copy(alpha = 0.25f))
                Spacer(modifier = Modifier.height(10.dp))

                summaries.forEach { summary ->
                    ClusterDistributionRow(summary = summary)
                    Spacer(modifier = Modifier.height(8.dp))
                }

                if (algorithm == AlgorithmType.DBSCAN && noiseCnt > 0) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.SpaceBetween
                    ) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Box(
                                modifier = Modifier
                                    .size(10.dp)
                                    .clip(CircleShape)
                                    .background(NoisePointColor)
                            )
                            Spacer(modifier = Modifier.width(8.dp))
                            Text(
                                text = "Noise / Unassigned Outliers",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                        Text(
                            text = "$noiseCnt pts",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun MetricPill(
    label: String,
    value: String,
    modifier: Modifier = Modifier
) {
    Surface(
        modifier = modifier,
        shape = RoundedCornerShape(12.dp),
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.65f)
    ) {
        Column(
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 8.dp),
            horizontalAlignment = Alignment.Start
        ) {
            Text(
                text = label,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1
            )
            Spacer(modifier = Modifier.height(2.dp))
            Text(
                text = value,
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold,
                color = MaterialTheme.colorScheme.onSurface
            )
        }
    }
}

@Composable
private fun ClusterDistributionRow(summary: ClusterSummary) {
    val color = ClusterColors[summary.clusterId % ClusterColors.size]
    Column(modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    modifier = Modifier
                        .size(12.dp)
                        .clip(CircleShape)
                        .background(color)
                )
                Spacer(modifier = Modifier.width(8.dp))
                Text(
                    text = "Cluster #${summary.clusterId + 1}",
                    style = MaterialTheme.typography.labelLarge
                )
                Spacer(modifier = Modifier.width(8.dp))
                Text(
                    text = "μ=(${"%.2f".format(summary.centroidX)}, ${"%.2f".format(summary.centroidY)})",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
            Text(
                text = "${summary.count} pts (${"%.0f".format(summary.percentage)}%)",
                style = MaterialTheme.typography.labelMedium
            )
        }
        Spacer(modifier = Modifier.height(4.dp))
        LinearProgressIndicator(
            progress = { (summary.percentage / 100f).coerceIn(0f, 1f) },
            modifier = Modifier
                .fillMaxWidth()
                .height(6.dp)
                .clip(RoundedCornerShape(3.dp)),
            color = color,
            trackColor = color.copy(alpha = 0.16f)
        )
    }
}
