package com.example.ui.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.OpenInNew
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Error
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.AutoAwesome
import androidx.compose.material.icons.outlined.DeleteOutline
import androidx.compose.material.icons.outlined.DynamicFeed
import androidx.compose.material.icons.outlined.FolderOpen
import androidx.compose.material.icons.outlined.PictureAsPdf
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material.icons.outlined.Share
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.example.R
import com.example.data.SavedDatasetEntity
import com.example.model.BatchJobStatus
import com.example.model.BatchProcessingState
import com.example.model.BatchQueueItem
import com.example.model.PresetDatasetType
import java.util.Locale

/**
 * Compact card in the 2D Lab letting users queue the active dataset, launch the Batch Queue
 * dialog, monitor sequential progress, and immediately open or share the latest combined PDF.
 */
@Composable
fun BatchProcessingQuickCard(
    batchState: BatchProcessingState,
    onQueueCurrentCanvas: () -> Unit,
    onOpenBatchDialog: () -> Unit,
    onOpenCombinedPdf: (String) -> Unit,
    onShareCombinedPdf: (String) -> Unit,
    modifier: Modifier = Modifier
) {
    Card(
        modifier = modifier
            .fillMaxWidth()
            .testTag("batch_processing_quick_card"),
        shape = RoundedCornerShape(18.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        elevation = CardDefaults.cardElevation(defaultElevation = 2.dp)
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    modifier = Modifier.weight(1f)
                ) {
                    Icon(
                        imageVector = Icons.Outlined.DynamicFeed,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.size(20.dp)
                    )
                    Column {
                        Text(
                            text = stringResource(R.string.batch_card_title),
                            style = MaterialTheme.typography.titleSmall,
                            fontWeight = FontWeight.Bold
                        )
                        Text(
                            text = if (batchState.queue.isEmpty()) {
                                stringResource(R.string.batch_card_subtitle)
                            } else {
                                "${batchState.queue.size} queued • ${batchState.completedCount} completed"
                            },
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }

                if (batchState.queue.isNotEmpty()) {
                    Surface(
                        shape = RoundedCornerShape(8.dp),
                        color = MaterialTheme.colorScheme.primaryContainer
                    ) {
                        Text(
                            text = "${batchState.queue.size}",
                            style = MaterialTheme.typography.labelMedium,
                            fontWeight = FontWeight.Bold,
                            color = MaterialTheme.colorScheme.onPrimaryContainer,
                            modifier = Modifier.padding(horizontal = 8.dp, vertical = 3.dp)
                        )
                    }
                }
            }

            if (batchState.isRunning) {
                LinearProgressIndicator(
                    progress = { batchState.progressFraction.coerceIn(0.05f, 1f) },
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(6.dp)
                        .clip(RoundedCornerShape(3.dp))
                )
            }

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                FilledTonalButton(
                    onClick = onQueueCurrentCanvas,
                    enabled = !batchState.isRunning,
                    modifier = Modifier
                        .weight(1f)
                        .heightIn(min = 48.dp)
                        .testTag("batch_quick_queue_current_button")
                ) {
                    Icon(
                        imageVector = Icons.Outlined.Add,
                        contentDescription = null,
                        modifier = Modifier.size(18.dp)
                    )
                    Spacer(modifier = Modifier.width(6.dp))
                    Text(stringResource(R.string.batch_action_add_current), maxLines = 1)
                }

                Button(
                    onClick = onOpenBatchDialog,
                    modifier = Modifier
                        .weight(1f)
                        .heightIn(min = 48.dp)
                        .testTag("batch_open_queue_dialog_button")
                ) {
                    Icon(
                        imageVector = Icons.Outlined.DynamicFeed,
                        contentDescription = null,
                        modifier = Modifier.size(18.dp)
                    )
                    Spacer(modifier = Modifier.width(6.dp))
                    Text(
                        if (batchState.queue.isEmpty()) "Batch Queue" else "Manage (${batchState.queue.size})",
                        maxLines = 1
                    )
                }
            }

            if (batchState.lastCombinedPdfFileName != null) {
                Surface(
                    shape = RoundedCornerShape(12.dp),
                    color = MaterialTheme.colorScheme.tertiaryContainer.copy(alpha = 0.55f),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 10.dp, vertical = 6.dp),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(6.dp),
                            modifier = Modifier.weight(1f)
                        ) {
                            Icon(
                                imageVector = Icons.Outlined.PictureAsPdf,
                                contentDescription = null,
                                tint = MaterialTheme.colorScheme.onTertiaryContainer,
                                modifier = Modifier.size(18.dp)
                            )
                            Column {
                                Text(
                                    text = batchState.lastCombinedPdfFileName,
                                    style = MaterialTheme.typography.labelMedium,
                                    fontWeight = FontWeight.SemiBold,
                                    color = MaterialTheme.colorScheme.onTertiaryContainer,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis
                                )
                                Text(
                                    text = "Combined PDF • ${batchState.lastCombinedPdfSizeLabel.orEmpty()}",
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.onTertiaryContainer.copy(alpha = 0.85f)
                                )
                            }
                        }

                        Row {
                            IconButton(
                                onClick = { onOpenCombinedPdf(batchState.lastCombinedPdfFileName) },
                                modifier = Modifier.testTag("batch_quick_open_pdf_button")
                            ) {
                                Icon(
                                    imageVector = Icons.AutoMirrored.Outlined.OpenInNew,
                                    contentDescription = "Open combined PDF report",
                                    tint = MaterialTheme.colorScheme.onTertiaryContainer
                                )
                            }
                            IconButton(
                                onClick = { onShareCombinedPdf(batchState.lastCombinedPdfFileName) },
                                modifier = Modifier.testTag("batch_quick_share_pdf_button")
                            ) {
                                Icon(
                                    imageVector = Icons.Outlined.Share,
                                    contentDescription = "Share combined PDF report",
                                    tint = MaterialTheme.colorScheme.onTertiaryContainer
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

/**
 * Full Batch Processing dialog allowing users to build a queue from the current canvas,
 * benchmark presets, or saved Room snapshots, run all queued datasets sequentially,
 * inspect results on the canvas, and automatically generate/open/share/export the combined
 * multi-page PDF summary report.
 */
@Composable
fun BatchProcessingDialog(
    batchState: BatchProcessingState,
    savedDatasets: List<SavedDatasetEntity>,
    onQueueCurrentCanvas: () -> Unit,
    onQueuePreset: (PresetDatasetType) -> Unit,
    onQueueSavedSnapshot: (SavedDatasetEntity) -> Unit,
    onQueueBenchmarkSuite: () -> Unit,
    onRemoveQueueItem: (Int) -> Unit,
    onClearQueue: () -> Unit,
    onRunBatchAndGeneratePdf: (String) -> Unit,
    onLoadResultToCanvas: (Int) -> Unit,
    onOpenCombinedPdf: (String) -> Unit,
    onShareCombinedPdf: (String) -> Unit,
    onExportCombinedPdfToFolder: (String) -> Unit,
    onDismiss: () -> Unit
) {
    var batchReportName by remember { mutableStateOf("ClusterLab_Batch_Summary") }
    val hasCompletedResults = batchState.queue.any { it.status == BatchJobStatus.COMPLETED }

    AlertDialog(
        onDismissRequest = { if (!batchState.isRunning) onDismiss() },
        icon = {
            Icon(
                imageVector = Icons.Outlined.DynamicFeed,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.primary
            )
        },
        title = {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Text(
                    text = stringResource(R.string.batch_dialog_title),
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold
                )
                Text(
                    text = stringResource(R.string.batch_dialog_subtitle),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        },
        text = {
            Column(
                modifier = Modifier.fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(10.dp)
            ) {
                OutlinedTextField(
                    value = batchReportName,
                    onValueChange = { batchReportName = it },
                    label = { Text("Combined PDF Report Name") },
                    singleLine = true,
                    enabled = !batchState.isRunning,
                    modifier = Modifier
                        .fillMaxWidth()
                        .testTag("batch_report_name_input")
                )

                // Quick-add actions: Current Canvas & 3-Preset Benchmark Suite
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    FilledTonalButton(
                        onClick = onQueueCurrentCanvas,
                        enabled = !batchState.isRunning,
                        modifier = Modifier
                            .weight(1f)
                            .heightIn(min = 48.dp)
                            .testTag("batch_dialog_add_current_button")
                    ) {
                        Icon(Icons.Outlined.Add, contentDescription = null, modifier = Modifier.size(16.dp))
                        Spacer(modifier = Modifier.width(4.dp))
                        Text("Current", maxLines = 1)
                    }
                    OutlinedButton(
                        onClick = onQueueBenchmarkSuite,
                        enabled = !batchState.isRunning,
                        modifier = Modifier
                            .weight(1.25f)
                            .heightIn(min = 48.dp)
                            .testTag("batch_dialog_add_suite_button")
                    ) {
                        Icon(Icons.Outlined.AutoAwesome, contentDescription = null, modifier = Modifier.size(16.dp))
                        Spacer(modifier = Modifier.width(4.dp))
                        Text(stringResource(R.string.batch_action_add_suite), maxLines = 1)
                    }
                }

                // Horizontal preset chips to quickly enqueue individual benchmark datasets
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(
                        text = "Quick-Add Presets (uses active algorithm)",
                        style = MaterialTheme.typography.labelSmall,
                        fontWeight = FontWeight.SemiBold,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .horizontalScroll(rememberScrollState()),
                        horizontalArrangement = Arrangement.spacedBy(6.dp)
                    ) {
                        PresetDatasetType.entries.forEach { preset ->
                            AssistChip(
                                onClick = { onQueuePreset(preset) },
                                enabled = !batchState.isRunning,
                                label = { Text("+ ${preset.title}") },
                                modifier = Modifier.testTag("batch_add_preset_${preset.name.lowercase()}")
                            )
                        }
                    }
                }

                if (savedDatasets.isNotEmpty()) {
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text(
                            text = "Quick-Add Saved Snapshots",
                            style = MaterialTheme.typography.labelSmall,
                            fontWeight = FontWeight.SemiBold,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .horizontalScroll(rememberScrollState()),
                            horizontalArrangement = Arrangement.spacedBy(6.dp)
                        ) {
                            savedDatasets.take(8).forEach { entity ->
                                AssistChip(
                                    onClick = { onQueueSavedSnapshot(entity) },
                                    enabled = !batchState.isRunning,
                                    label = { Text("+ ${entity.title}") },
                                    modifier = Modifier.testTag("batch_add_saved_${entity.id}")
                                )
                            }
                        }
                    }
                }

                // Live Sequential Progress Indicator
                if (batchState.isRunning) {
                    val runningItem = batchState.queue.getOrNull(batchState.currentJobIndex)
                    Surface(
                        shape = RoundedCornerShape(12.dp),
                        color = MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.55f),
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Column(
                            modifier = Modifier.padding(10.dp),
                            verticalArrangement = Arrangement.spacedBy(6.dp)
                        ) {
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(8.dp)
                            ) {
                                CircularProgressIndicator(
                                    modifier = Modifier.size(16.dp),
                                    strokeWidth = 2.dp
                                )
                                Text(
                                    text = if (runningItem != null) {
                                        "Clustering ${batchState.currentJobIndex + 1}/${batchState.queue.size}: ${runningItem.datasetTitle}…"
                                    } else {
                                        "Generating combined PDF summary…"
                                    },
                                    style = MaterialTheme.typography.labelMedium,
                                    fontWeight = FontWeight.SemiBold,
                                    color = MaterialTheme.colorScheme.onPrimaryContainer
                                )
                            }
                            LinearProgressIndicator(
                                progress = { batchState.progressFraction.coerceIn(0.05f, 1f) },
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .height(5.dp)
                                    .clip(RoundedCornerShape(3.dp))
                            )
                        }
                    }
                }

                // Combined PDF Banner after batch completion
                if (!batchState.isRunning && batchState.lastCombinedPdfFileName != null && hasCompletedResults) {
                    Surface(
                        shape = RoundedCornerShape(12.dp),
                        color = MaterialTheme.colorScheme.tertiaryContainer.copy(alpha = 0.65f),
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Column(
                            modifier = Modifier.padding(10.dp),
                            verticalArrangement = Arrangement.spacedBy(6.dp)
                        ) {
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(6.dp)
                            ) {
                                Icon(
                                    imageVector = Icons.Outlined.PictureAsPdf,
                                    contentDescription = null,
                                    tint = MaterialTheme.colorScheme.onTertiaryContainer,
                                    modifier = Modifier.size(18.dp)
                                )
                                Text(
                                    text = "Combined PDF Ready: ${batchState.lastCombinedPdfFileName}",
                                    style = MaterialTheme.typography.labelMedium,
                                    fontWeight = FontWeight.Bold,
                                    color = MaterialTheme.colorScheme.onTertiaryContainer,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis
                                )
                            }
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.spacedBy(6.dp)
                            ) {
                                OutlinedButton(
                                    onClick = { onOpenCombinedPdf(batchState.lastCombinedPdfFileName) },
                                    modifier = Modifier
                                        .weight(1f)
                                        .heightIn(min = 48.dp)
                                        .testTag("batch_dialog_open_pdf_button")
                                ) {
                                    Icon(Icons.AutoMirrored.Outlined.OpenInNew, contentDescription = null, modifier = Modifier.size(15.dp))
                                    Spacer(modifier = Modifier.width(4.dp))
                                    Text("Open")
                                }
                                OutlinedButton(
                                    onClick = { onShareCombinedPdf(batchState.lastCombinedPdfFileName) },
                                    modifier = Modifier
                                        .weight(1f)
                                        .heightIn(min = 48.dp)
                                        .testTag("batch_dialog_share_pdf_button")
                                ) {
                                    Icon(Icons.Outlined.Share, contentDescription = null, modifier = Modifier.size(15.dp))
                                    Spacer(modifier = Modifier.width(4.dp))
                                    Text("Share")
                                }
                                OutlinedButton(
                                    onClick = { onExportCombinedPdfToFolder(batchReportName) },
                                    modifier = Modifier
                                        .weight(1f)
                                        .heightIn(min = 48.dp)
                                        .testTag("batch_dialog_export_saf_pdf_button")
                                ) {
                                    Icon(Icons.Outlined.FolderOpen, contentDescription = null, modifier = Modifier.size(15.dp))
                                    Spacer(modifier = Modifier.width(4.dp))
                                    Text("Save")
                                }
                            }
                        }
                    }
                }

                // Queued Datasets List
                if (batchState.queue.isEmpty()) {
                    Surface(
                        shape = RoundedCornerShape(12.dp),
                        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.55f),
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Text(
                            text = stringResource(R.string.batch_empty_state),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(14.dp)
                        )
                    }
                } else {
                    LazyColumn(
                        modifier = Modifier
                            .fillMaxWidth()
                            .heightIn(max = 260.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp)
                    ) {
                        itemsIndexed(batchState.queue, key = { _, item -> item.jobId }) { idx, item ->
                            BatchQueueItemRow(
                                index = idx + 1,
                                item = item,
                                isBatchRunning = batchState.isRunning,
                                onViewOnCanvas = {
                                    onLoadResultToCanvas(item.jobId)
                                    onDismiss()
                                },
                                onRemove = { onRemoveQueueItem(item.jobId) }
                            )
                        }
                    }
                }

                if (batchState.queue.isNotEmpty()) {
                    HorizontalDivider(color = MaterialTheme.colorScheme.outline.copy(alpha = 0.25f))
                }
            }
        },
        dismissButton = {
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                if (batchState.queue.isNotEmpty() && !batchState.isRunning) {
                    TextButton(
                        onClick = onClearQueue,
                        modifier = Modifier
                            .heightIn(min = 48.dp)
                            .testTag("batch_clear_queue_button")
                    ) {
                        Text(
                            text = stringResource(R.string.batch_action_clear),
                            color = MaterialTheme.colorScheme.error
                        )
                    }
                }
                TextButton(
                    onClick = onDismiss,
                    enabled = !batchState.isRunning,
                    modifier = Modifier
                        .heightIn(min = 48.dp)
                        .testTag("batch_close_dialog_button")
                ) {
                    Text("Close")
                }
            }
        },
        confirmButton = {
            Button(
                onClick = { onRunBatchAndGeneratePdf(batchReportName) },
                enabled = batchState.queue.isNotEmpty() && !batchState.isRunning,
                modifier = Modifier
                    .heightIn(min = 48.dp)
                    .testTag("batch_run_all_button")
            ) {
                Icon(
                    imageVector = Icons.Filled.PlayArrow,
                    contentDescription = null,
                    modifier = Modifier.size(18.dp)
                )
                Spacer(modifier = Modifier.width(4.dp))
                Text(stringResource(R.string.batch_action_run))
            }
        }
    )
}

@Composable
private fun BatchQueueItemRow(
    index: Int,
    item: BatchQueueItem,
    isBatchRunning: Boolean,
    onViewOnCanvas: () -> Unit,
    onRemove: () -> Unit
) {
    val isCompleted = item.status == BatchJobStatus.COMPLETED
    val isRunning = item.status == BatchJobStatus.RUNNING
    val isFailed = item.status == BatchJobStatus.FAILED

    Surface(
        shape = RoundedCornerShape(12.dp),
        color = when {
            isRunning -> MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.55f)
            isCompleted -> MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.65f)
            else -> MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f)
        },
        border = BorderStroke(
            width = if (isRunning) 1.5.dp else 1.dp,
            color = if (isRunning) {
                MaterialTheme.colorScheme.primary
            } else {
                MaterialTheme.colorScheme.outline.copy(alpha = 0.25f)
            }
        ),
        modifier = Modifier
            .fillMaxWidth()
            .testTag("batch_queue_item_${item.jobId}")
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 10.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                modifier = Modifier.weight(1f)
            ) {
                when (item.status) {
                    BatchJobStatus.RUNNING -> CircularProgressIndicator(
                        modifier = Modifier.size(18.dp),
                        strokeWidth = 2.dp
                    )
                    BatchJobStatus.COMPLETED -> Icon(
                        imageVector = Icons.Filled.CheckCircle,
                        contentDescription = "Completed",
                        tint = MaterialTheme.colorScheme.tertiary,
                        modifier = Modifier.size(18.dp)
                    )
                    BatchJobStatus.FAILED -> Icon(
                        imageVector = Icons.Filled.Error,
                        contentDescription = "Failed",
                        tint = MaterialTheme.colorScheme.error,
                        modifier = Modifier.size(18.dp)
                    )
                    BatchJobStatus.QUEUED -> Icon(
                        imageVector = Icons.Outlined.Schedule,
                        contentDescription = "Queued",
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.size(18.dp)
                    )
                }

                Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(
                        text = "$index. ${item.datasetTitle}",
                        style = MaterialTheme.typography.labelLarge,
                        fontWeight = FontWeight.Bold,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )
                    Text(
                        text = "${item.parameterSummary} • ${item.rawPoints.size} pts (${item.sourceLabel})",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )
                    if (isCompleted && item.resultFrame != null) {
                        Text(
                            text = String.format(
                                Locale.US,
                                "%d groups • Sil %.2f • Inertia %.3f • %dms",
                                item.resultFrame.clusterSummaries.size,
                                item.resultFrame.silhouetteScore,
                                item.resultFrame.wcss,
                                item.durationMs
                            ),
                            style = MaterialTheme.typography.labelSmall,
                            fontWeight = FontWeight.SemiBold,
                            color = MaterialTheme.colorScheme.primary
                        )
                    } else if (isFailed && item.errorMessage != null) {
                        Text(
                            text = item.errorMessage,
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.error
                        )
                    }
                }
            }

            Row(verticalAlignment = Alignment.CenterVertically) {
                if (isCompleted) {
                    IconButton(
                        onClick = onViewOnCanvas,
                        modifier = Modifier.testTag("batch_view_item_${item.jobId}")
                    ) {
                        Icon(
                            imageVector = Icons.Outlined.Visibility,
                            contentDescription = "Inspect ${item.datasetTitle} on canvas",
                            tint = MaterialTheme.colorScheme.primary
                        )
                    }
                }
                if (!isBatchRunning) {
                    IconButton(
                        onClick = onRemove,
                        modifier = Modifier.testTag("batch_remove_item_${item.jobId}")
                    ) {
                        Icon(
                            imageVector = Icons.Outlined.DeleteOutline,
                            contentDescription = "Remove ${item.datasetTitle} from batch queue",
                            tint = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }
            }
        }
    }
}
