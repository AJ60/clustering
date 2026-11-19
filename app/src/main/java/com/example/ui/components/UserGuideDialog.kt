package com.example.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.HelpOutline
import androidx.compose.material.icons.outlined.AutoAwesome
import androidx.compose.material.icons.outlined.Code
import androidx.compose.material.icons.outlined.Devices
import androidx.compose.material.icons.outlined.History
import androidx.compose.material.icons.outlined.Insights
import androidx.compose.material.icons.outlined.PictureAsPdf
import androidx.compose.material.icons.outlined.TouchApp
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.example.R

/**
 * Beginner-friendly step-by-step User Guide explaining how to use the 2D Clustering Lab,
 * interpret the live Silhouette & Inertia overlay, save PDF reports, connect auto-optimized
 * worker phones, and toggle Developer Mode when advanced controls are needed.
 */
@Composable
fun UserGuideDialog(
    onDismiss: () -> Unit,
    onReplayInteractiveTour: (() -> Unit)? = null
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        icon = {
            Icon(
                imageVector = Icons.AutoMirrored.Outlined.HelpOutline,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.primary
            )
        },
        title = {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Text(
                    text = stringResource(R.string.user_guide_title),
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold
                )
                Text(
                    text = stringResource(R.string.user_guide_subtitle),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        },
        text = {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(max = 420.dp)
                    .verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(10.dp)
            ) {
                GuideStepCard(
                    stepNumber = "1",
                    icon = Icons.Outlined.TouchApp,
                    title = "Tap to Add Points & Watch Clusters Update",
                    body = "Tap anywhere on the 2D canvas to place points, or choose a sample shape below (like Two Moons or Blobs). Cluster centers (diamonds) move automatically in real time."
                )

                GuideStepCard(
                    stepNumber = "2",
                    icon = Icons.Outlined.Insights,
                    title = "Read the Live Quality Overlay",
                    body = "Check the floating score badge on the canvas to judge cluster quality:\n" +
                        "• Silhouette (−1 to 1): Closer to 1.00 means cleaner, well-separated groups (0.50+ is good).\n" +
                        "• Inertia (WCSS): Lower values mean tighter, more compact K-Means clusters.\n" +
                        "Tap the badge anytime to switch between Both, Silhouette, or Inertia."
                )

                GuideStepCard(
                    stepNumber = "3",
                    icon = Icons.Outlined.AutoAwesome,
                    title = "Pick K-Means or DBSCAN",
                    body = "Use K-Means when you want a specific number of groups (slide K). Switch to DBSCAN to discover curved shapes and automatically mark stray outliers with an X."
                )

                GuideStepCard(
                    stepNumber = "4",
                    icon = Icons.Outlined.History,
                    title = "Compare Runs with Session History",
                    body = "ClusterLab automatically tracks your last 10 clustering runs and their Inertia scores. Tap any chip in the Session History strip or the top-bar History icon to compare runs and jump back to an earlier state."
                )

                GuideStepCard(
                    stepNumber = "5",
                    icon = Icons.Outlined.PictureAsPdf,
                    title = "Save a PDF Summary Report",
                    body = "Tap the PDF icon in the top bar or the Save PDF card to export a printable summary with a snapshot of your plot and key statistics."
                )

                GuideStepCard(
                    stepNumber = "6",
                    icon = Icons.Outlined.Devices,
                    title = "Connect Phone as an Auto-Optimized Worker",
                    body = "Open the Connect Phone tab and tap Auto-Connect or Scan QR on your PC. Your phone automatically tunes CPU threads, Vulkan/NEON speed, heat protection, and a safe ≤50% memory cap."
                )

                GuideStepCard(
                    stepNumber = "7",
                    icon = Icons.Outlined.Code,
                    title = "Eye Comfort & Developer Mode",
                    body = "Tap the Settings gear icon to switch between Dark and Light mode (saved automatically). Turn on Developer Mode inside Settings whenever you want advanced controls like CSV import/export, playback stepping, Voronoi/MinPts tuning, or raw node diagnostics."
                )

                Text(
                    text = stringResource(R.string.about_clusterlab_footer),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = 4.dp)
                )
            }
        },
        dismissButton = if (onReplayInteractiveTour != null) {
            {
                TextButton(
                    onClick = onReplayInteractiveTour,
                    modifier = Modifier
                        .heightIn(min = 48.dp)
                        .testTag("replay_coach_mark_tour_button")
                ) {
                    Text(stringResource(R.string.action_replay_tour))
                }
            }
        } else null,
        confirmButton = {
            Button(
                onClick = onDismiss,
                modifier = Modifier
                    .heightIn(min = 48.dp)
                    .testTag("close_user_guide_button")
            ) {
                Text(stringResource(R.string.btn_got_it))
            }
        }
    )
}

@Composable
private fun GuideStepCard(
    stepNumber: String,
    icon: ImageVector,
    title: String,
    body: String
) {
    Surface(
        shape = RoundedCornerShape(14.dp),
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.55f),
        modifier = Modifier.fillMaxWidth()
    ) {
        Column(
            modifier = Modifier.padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(5.dp)
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                Surface(
                    shape = RoundedCornerShape(8.dp),
                    color = MaterialTheme.colorScheme.primaryContainer
                ) {
                    Text(
                        text = stepNumber,
                        style = MaterialTheme.typography.labelMedium,
                        fontWeight = FontWeight.Bold,
                        color = MaterialTheme.colorScheme.onPrimaryContainer,
                        modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp)
                    )
                }
                Icon(
                    imageVector = icon,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.size(18.dp)
                )
                Spacer(modifier = Modifier.width(2.dp))
                Text(
                    text = title,
                    style = MaterialTheme.typography.labelLarge,
                    fontWeight = FontWeight.Bold,
                    color = MaterialTheme.colorScheme.onSurface
                )
            }
            Text(
                text = body,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}
