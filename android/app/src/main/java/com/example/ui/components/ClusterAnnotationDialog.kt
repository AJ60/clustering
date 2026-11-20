package com.example.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.DeleteOutline
import androidx.compose.material.icons.outlined.PictureAsPdf
import androidx.compose.material.icons.outlined.StickyNote2
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SuggestionChip
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
import androidx.compose.ui.unit.dp
import com.example.R
import com.example.model.ClusterAnnotation
import com.example.ui.theme.ClusterColors
import com.example.ui.theme.NoisePointColor
import java.util.Locale

private const val MAX_ANNOTATION_CHARS = 120

private val QuickAnnotationSuggestions = listOf(
    "Dense Core",
    "Primary Segment",
    "Boundary Zone",
    "Outlier Pocket"
)

@Composable
fun ClusterAnnotationDialog(
    clusterId: Int,
    worldX: Float,
    worldY: Float,
    existingAnnotation: ClusterAnnotation?,
    onDismiss: () -> Unit,
    onSave: (String) -> Unit,
    onDelete: (() -> Unit)? = null
) {
    var noteText by remember(existingAnnotation?.id) {
        mutableStateOf(existingAnnotation?.text.orEmpty())
    }
    val isEditing = existingAnnotation != null
    val clusterColor = if (clusterId >= 0) {
        ClusterColors[clusterId % ClusterColors.size]
    } else {
        NoisePointColor
    }
    val clusterLabel = if (clusterId >= 0) {
        "Cluster ${clusterId + 1}"
    } else {
        "Noise / Canvas Area"
    }
    val coordLabel = String.format(Locale.US, "(%.2f, %.2f)", worldX, worldY)

    AlertDialog(
        onDismissRequest = onDismiss,
        icon = {
            Icon(
                imageVector = Icons.Outlined.StickyNote2,
                contentDescription = null,
                tint = clusterColor
            )
        },
        title = {
            Text(
                text = stringResource(
                    if (isEditing) R.string.annotation_dialog_edit_title
                    else R.string.annotation_dialog_add_title
                ),
                style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.Bold
            )
        },
        text = {
            Column(
                modifier = Modifier.fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(12.dp)
            ) {
                // Target cluster swatch & world coordinate badge
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    Surface(
                        shape = RoundedCornerShape(10.dp),
                        color = clusterColor.copy(alpha = 0.16f)
                    ) {
                        Row(
                            modifier = Modifier.padding(horizontal = 10.dp, vertical = 5.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(6.dp)
                        ) {
                            Box(
                                modifier = Modifier
                                    .size(9.dp)
                                    .clip(CircleShape)
                                    .background(clusterColor)
                            )
                            Text(
                                text = clusterLabel,
                                style = MaterialTheme.typography.labelMedium,
                                fontWeight = FontWeight.Bold,
                                color = MaterialTheme.colorScheme.onSurface
                            )
                        }
                    }

                    Surface(
                        shape = RoundedCornerShape(10.dp),
                        color = MaterialTheme.colorScheme.surfaceVariant
                    ) {
                        Text(
                            text = coordLabel,
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(horizontal = 9.dp, vertical = 5.dp)
                        )
                    }
                }

                OutlinedTextField(
                    value = noteText,
                    onValueChange = { updated ->
                        noteText = updated.take(MAX_ANNOTATION_CHARS)
                    },
                    label = { Text(stringResource(R.string.annotation_input_label)) },
                    placeholder = { Text(stringResource(R.string.annotation_input_placeholder)) },
                    supportingText = {
                        Text("${noteText.length}/$MAX_ANNOTATION_CHARS")
                    },
                    minLines = 2,
                    maxLines = 3,
                    modifier = Modifier
                        .fillMaxWidth()
                        .testTag("annotation_text_input")
                )

                // Quick label suggestions for fast tagging on mobile touchscreens
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    QuickAnnotationSuggestions.forEach { suggestion ->
                        SuggestionChip(
                            onClick = { noteText = suggestion },
                            label = {
                                Text(
                                    text = suggestion,
                                    style = MaterialTheme.typography.labelSmall
                                )
                            },
                            modifier = Modifier.heightIn(min = 40.dp)
                        )
                    }
                }

                // Clear PDF report inclusion indicator
                Surface(
                    shape = RoundedCornerShape(12.dp),
                    color = MaterialTheme.colorScheme.secondaryContainer.copy(alpha = 0.65f)
                ) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 10.dp, vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp)
                    ) {
                        Icon(
                            imageVector = Icons.Outlined.PictureAsPdf,
                            contentDescription = null,
                            tint = MaterialTheme.colorScheme.onSecondaryContainer,
                            modifier = Modifier.size(16.dp)
                        )
                        Text(
                            text = stringResource(R.string.annotation_pdf_badge_hint),
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSecondaryContainer
                        )
                    }
                }
            }
        },
        confirmButton = {
            Button(
                onClick = {
                    val trimmed = noteText.trim()
                    if (trimmed.isNotEmpty()) {
                        onSave(trimmed)
                    }
                },
                enabled = noteText.trim().isNotEmpty(),
                modifier = Modifier
                    .heightIn(min = 48.dp)
                    .testTag("annotation_save_button")
            ) {
                Text(stringResource(R.string.btn_save))
            }
        },
        dismissButton = {
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                if (isEditing && onDelete != null) {
                    TextButton(
                        onClick = onDelete,
                        modifier = Modifier
                            .heightIn(min = 48.dp)
                            .testTag("annotation_delete_button")
                    ) {
                        Icon(
                            imageVector = Icons.Outlined.DeleteOutline,
                            contentDescription = null,
                            tint = MaterialTheme.colorScheme.error,
                            modifier = Modifier.size(18.dp)
                        )
                        Spacer(modifier = Modifier.width(4.dp))
                        Text(
                            text = stringResource(R.string.btn_delete),
                            color = MaterialTheme.colorScheme.error
                        )
                    }
                }
                TextButton(
                    onClick = onDismiss,
                    modifier = Modifier
                        .heightIn(min = 48.dp)
                        .testTag("annotation_cancel_button")
                ) {
                    Text(stringResource(R.string.btn_cancel))
                }
            }
        }
    )
}
