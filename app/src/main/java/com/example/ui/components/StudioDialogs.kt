package com.example.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.FolderOpen
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.example.R
import com.example.data.SavedDatasetEntity
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

@Composable
fun SaveSnapshotDialog(
    initialTitle: String,
    onDismiss: () -> Unit,
    onConfirmSave: (String) -> Unit
) {
    var title by remember { mutableStateOf(initialTitle) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Text(
                text = stringResource(R.string.dialog_save_title),
                style = MaterialTheme.typography.titleLarge
            )
        },
        text = {
            Column {
                Text(
                    text = "Store the current 2D point cloud and algorithm parameters in local Room storage.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                Spacer(modifier = Modifier.height(12.dp))
                OutlinedTextField(
                    value = title,
                    onValueChange = { title = it },
                    label = { Text(stringResource(R.string.dialog_save_hint)) },
                    singleLine = true,
                    modifier = Modifier
                        .fillMaxWidth()
                        .testTag("save_snapshot_name_input")
                )
            }
        },
        confirmButton = {
            FilledTonalButton(
                onClick = { onConfirmSave(title) },
                modifier = Modifier.testTag("confirm_save_snapshot_button")
            ) {
                Text(stringResource(R.string.btn_save))
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text(stringResource(R.string.btn_cancel))
            }
        }
    )
}

@Composable
fun SavedSnapshotsDialog(
    savedDatasets: List<SavedDatasetEntity>,
    onDismiss: () -> Unit,
    onLoadSnapshot: (SavedDatasetEntity) -> Unit,
    onDeleteSnapshot: (Int) -> Unit
) {
    val dateFormat = remember { SimpleDateFormat("MMM d, HH:mm", Locale.getDefault()) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Text(
                text = stringResource(R.string.action_saved_workspaces),
                style = MaterialTheme.typography.titleLarge
            )
        },
        text = {
            if (savedDatasets.isEmpty()) {
                Text(
                    text = "No local snapshots saved yet. Tap 'Save Snapshot' in the top bar to store your custom datasets.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            } else {
                LazyColumn(
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(max = 340.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    items(savedDatasets, key = { it.id }) { item ->
                        Card(
                            shape = RoundedCornerShape(14.dp),
                            colors = CardDefaults.cardColors(
                                containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.65f)
                            ),
                            modifier = Modifier.fillMaxWidth()
                        ) {
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(12.dp),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.SpaceBetween
                            ) {
                                Column(modifier = Modifier.weight(1f)) {
                                    Text(
                                        text = item.title,
                                        style = MaterialTheme.typography.titleSmall,
                                        fontWeight = FontWeight.Bold
                                    )
                                    Text(
                                        text = "${item.algorithm} • ${item.pointCount} pts • ${dateFormat.format(Date(item.createdAt))}",
                                        style = MaterialTheme.typography.labelSmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant
                                    )
                                }
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    FilledTonalButton(
                                        onClick = {
                                            onLoadSnapshot(item)
                                            onDismiss()
                                        },
                                        modifier = Modifier.testTag("load_snapshot_${item.id}")
                                    ) {
                                        Icon(
                                            imageVector = Icons.Outlined.FolderOpen,
                                            contentDescription = null
                                        )
                                        Spacer(modifier = Modifier.width(4.dp))
                                        Text(stringResource(R.string.btn_load))
                                    }
                                    IconButton(
                                        onClick = { onDeleteSnapshot(item.id) },
                                        modifier = Modifier.testTag("delete_snapshot_${item.id}")
                                    ) {
                                        Icon(
                                            imageVector = Icons.Outlined.Delete,
                                            contentDescription = stringResource(R.string.btn_delete),
                                            tint = MaterialTheme.colorScheme.error
                                        )
                                    }
                                }
                            }
                        }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = onDismiss) {
                Text("Close")
            }
        }
    )
}

@Composable
fun PasteDatasetDialog(
    onDismiss: () -> Unit,
    onParseAndLoad: (String, String) -> Unit
) {
    var title by remember { mutableStateOf("Repo Dataset") }
    var rawContent by remember {
        mutableStateOf(
            "0.22, 0.28\n0.25, 0.31\n0.20, 0.25\n0.74, 0.72\n0.77, 0.69\n0.71, 0.75\n0.25, 0.76\n0.28, 0.72"
        )
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Text(
                text = stringResource(R.string.dialog_paste_title),
                style = MaterialTheme.typography.titleLarge
            )
        },
        text = {
            Column {
                Text(
                    text = "Paste CSV (x,y), TSV, JSON point arrays, or numeric coordinate tables from your repository.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                Spacer(modifier = Modifier.height(10.dp))
                OutlinedTextField(
                    value = title,
                    onValueChange = { title = it },
                    label = { Text("Dataset Title") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth()
                )
                Spacer(modifier = Modifier.height(8.dp))
                OutlinedTextField(
                    value = rawContent,
                    onValueChange = { rawContent = it },
                    label = { Text(stringResource(R.string.dialog_paste_hint)) },
                    minLines = 5,
                    maxLines = 9,
                    modifier = Modifier
                        .fillMaxWidth()
                        .testTag("paste_dataset_input")
                )
            }
        },
        confirmButton = {
            FilledTonalButton(
                onClick = {
                    onParseAndLoad(rawContent, title.ifBlank { "Pasted Dataset" })
                    onDismiss()
                },
                modifier = Modifier.testTag("confirm_paste_load_button")
            ) {
                Text(stringResource(R.string.btn_parse_load))
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text(stringResource(R.string.btn_cancel))
            }
        }
    )
}
