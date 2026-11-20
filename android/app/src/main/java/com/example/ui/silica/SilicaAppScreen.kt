package com.example.ui.silica

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Chat
import androidx.compose.material.icons.filled.Dns
import androidx.compose.material.icons.filled.Hub
import androidx.compose.material.icons.filled.QrCodeScanner
import androidx.compose.material.icons.filled.ScatterPlot
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.example.service.RpcService
import com.example.service.WorkerRunState

enum class SilicaTab {
    SETUP,
    DISTRIBUTED,
    CHAT
}

/**
 * SilicaAppScreen — Main Navigation Host modeled after Silica Cluster
 * (https://github.com/ShintoChakkiath/Silica-Cluster-Decentralized-Mobile-AI).
 *
 * Provides a clean 3-tab layout:
 * - SETUP (Command Center & Hardware Telemetry Deck)
 * - CLUSTER (Visual Layer Sharding & Distributed Topology)
 * - CHAT (Decentralized Local & Sharded Mobile AI Inference)
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SilicaAppScreen(
    onOpenLegacy2DLab: (() -> Unit)? = null
) {
    var selectedTab by remember { mutableStateOf(SilicaTab.SETUP) }
    val telemetry by RpcService.telemetry.collectAsStateWithLifecycle()

    val isOnline = telemetry.workerState == WorkerRunState.RUNNING_USB ||
            telemetry.workerState == WorkerRunState.RUNNING_WIFI

    val statusDotColor = if (isOnline) Color(0xFF10B981) else Color(0xFF64748B)
    val statusText = if (isOnline) "ONLINE" else "STANDBY"

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(8.dp)
                        ) {
                            Text(
                                text = "Silica Cluster",
                                style = MaterialTheme.typography.titleMedium,
                                fontWeight = FontWeight.ExtraBold
                            )
                            Surface(
                                shape = CircleShape,
                                color = statusDotColor.copy(alpha = 0.15f)
                            ) {
                                Row(
                                    modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(4.dp)
                                ) {
                                    Box(
                                        modifier = Modifier
                                            .size(6.dp)
                                            .clip(CircleShape)
                                            .background(statusDotColor)
                                    )
                                    Text(
                                        text = statusText,
                                        fontSize = 9.sp,
                                        fontWeight = FontWeight.Bold,
                                        color = statusDotColor
                                    )
                                }
                            }
                        }
                        Text(
                            text = "Decentralized Mobile AI Infrastructure",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                },
                actions = {
                    if (onOpenLegacy2DLab != null) {
                        IconButton(onClick = onOpenLegacy2DLab) {
                            Icon(
                                imageVector = Icons.Default.ScatterPlot,
                                contentDescription = "2D Canvas Studio",
                                tint = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
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
                    selected = selectedTab == SilicaTab.SETUP,
                    onClick = { selectedTab = SilicaTab.SETUP },
                    icon = { Icon(Icons.Default.Dns, contentDescription = "Command Center") },
                    label = { Text("Command") }
                )
                NavigationBarItem(
                    selected = selectedTab == SilicaTab.DISTRIBUTED,
                    onClick = { selectedTab = SilicaTab.DISTRIBUTED },
                    icon = { Icon(Icons.Default.Hub, contentDescription = "Cluster Map") },
                    label = { Text("Cluster") }
                )
                NavigationBarItem(
                    selected = selectedTab == SilicaTab.CHAT,
                    onClick = { selectedTab = SilicaTab.CHAT },
                    icon = { Icon(Icons.Default.Chat, contentDescription = "AI Chat") },
                    label = { Text("Chat") }
                )
            }
        }
    ) { padding ->
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
        ) {
            when (selectedTab) {
                SilicaTab.SETUP -> SilicaSetupScreen()
                SilicaTab.DISTRIBUTED -> SilicaDistributedScreen()
                SilicaTab.CHAT -> SilicaChatScreen()
            }
        }
    }
}
