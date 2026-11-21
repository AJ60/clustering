package com.example.ui.silica

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Send
import androidx.compose.material.icons.outlined.AddComment
import androidx.compose.material.icons.outlined.AutoAwesome
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.Forum
import androidx.compose.material.icons.outlined.Radar
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.Stop
import androidx.compose.material.icons.outlined.Tune
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.example.R
import com.example.data.ChatMessageEntity

@Composable
fun SilicaChatScreen(
    uiState: SilicaUiState,
    onSendPrompt: (String) -> Unit,
    onStopStreaming: () -> Unit,
    onOpenModelEndpointSheet: () -> Unit,
    onOpenSessionsDialog: () -> Unit,
    onNewSession: () -> Unit,
    onAutoDetect: () -> Unit
) {
    val cs = MaterialTheme.colorScheme
    val context = LocalContext.current
    var promptText by rememberSaveable { mutableStateOf("") }
    val listState = rememberLazyListState()

    LaunchedEffect(uiState.messages.size, uiState.messages.lastOrNull()?.content?.length) {
        if (uiState.messages.isNotEmpty()) {
            listState.animateScrollToItem(uiState.messages.lastIndex)
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .imePadding()
            .testTag("chat_screen_root")
    ) {
        // 1. Active Model & Master Pipeline Top Banner
        Surface(
            color = cs.surfaceContainer,
            border = BorderStroke(1.dp, cs.outlineVariant),
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 10.dp)
                .clip(MaterialTheme.shapes.medium)
                .clickable(onClick = onOpenModelEndpointSheet)
                .testTag("chat_model_banner")
        ) {
            Row(
                modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    modifier = Modifier.weight(1f)
                ) {
                    Box(
                        modifier = Modifier
                            .size(9.dp)
                            .clip(CircleShape)
                            .background(if (uiState.masterHealth.reachable) cs.primary else cs.error)
                    )
                    Column(modifier = Modifier.weight(1f)) {
                        Text(
                            text = uiState.activeModelDisplayName,
                            style = MaterialTheme.typography.titleSmall,
                            color = cs.onSurface,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis
                        )
                        Text(
                            text = "${uiState.config.masterBaseUrl} • ${uiState.activeNodeCount} node(s)" +
                                if (uiState.isStreamingChat && uiState.liveStreamingTokPerSec > 0f) {
                                    " • ${"%.1f".format(uiState.liveStreamingTokPerSec)} tok/s"
                                } else "",
                            style = MaterialTheme.typography.labelSmall,
                            color = if (uiState.masterHealth.reachable) cs.secondary else cs.onSurfaceVariant,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis
                        )
                    }
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    IconButton(
                        onClick = onOpenSessionsDialog,
                        modifier = Modifier.testTag("chat_sessions_button")
                    ) {
                        Icon(
                            imageVector = Icons.Outlined.Forum,
                            contentDescription = stringResource(R.string.chat_sessions),
                            tint = cs.onSurfaceVariant,
                            modifier = Modifier.size(19.dp)
                        )
                    }
                    IconButton(
                        onClick = onNewSession,
                        modifier = Modifier.testTag("chat_new_session_button")
                    ) {
                        Icon(
                            imageVector = Icons.Outlined.AddComment,
                            contentDescription = stringResource(R.string.chat_new_session),
                            tint = cs.secondary,
                            modifier = Modifier.size(19.dp)
                        )
                    }
                    IconButton(
                        onClick = onOpenModelEndpointSheet,
                        modifier = Modifier.testTag("chat_endpoint_button")
                    ) {
                        Icon(
                            imageVector = Icons.Outlined.Tune,
                            contentDescription = stringResource(R.string.chat_endpoint_config),
                            tint = cs.primary,
                            modifier = Modifier.size(19.dp)
                        )
                    }
                }
            }
        }

        // 2. Actionable Offline Master Diagnostic Banner (Zero mock replies!)
        AnimatedVisibility(visible = !uiState.masterHealth.reachable) {
            Surface(
                shape = MaterialTheme.shapes.medium,
                color = cs.errorContainer.copy(alpha = 0.55f),
                border = BorderStroke(1.dp, cs.error.copy(alpha = 0.5f)),
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp, vertical = 4.dp)
            ) {
                Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp)
                    ) {
                        Icon(
                            imageVector = Icons.Outlined.ErrorOutline,
                            contentDescription = null,
                            tint = cs.error,
                            modifier = Modifier.size(18.dp)
                        )
                        Text(
                            text = stringResource(R.string.chat_offline_title),
                            style = MaterialTheme.typography.titleSmall,
                            color = cs.onErrorContainer
                        )
                    }
                    Text(
                        text = stringResource(R.string.chat_offline_body),
                        style = MaterialTheme.typography.bodySmall,
                        color = cs.onErrorContainer.copy(alpha = 0.9f)
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(
                            onClick = onAutoDetect,
                            colors = ButtonDefaults.buttonColors(
                                containerColor = cs.primary,
                                contentColor = cs.onPrimary
                            ),
                            contentPadding = PaddingValues(horizontal = 12.dp, vertical = 6.dp),
                            modifier = Modifier
                                .minimumInteractiveComponentSize()
                                .testTag("chat_offline_autodetect_button")
                        ) {
                            Icon(Icons.Outlined.Radar, contentDescription = null, modifier = Modifier.size(15.dp))
                            Spacer(Modifier.width(5.dp))
                            Text(stringResource(R.string.cluster_auto_detect), style = MaterialTheme.typography.labelSmall)
                        }
                        OutlinedButton(
                            onClick = onOpenModelEndpointSheet,
                            border = BorderStroke(1.dp, cs.onErrorContainer.copy(alpha = 0.5f)),
                            contentPadding = PaddingValues(horizontal = 12.dp, vertical = 6.dp),
                            modifier = Modifier
                                .minimumInteractiveComponentSize()
                                .testTag("chat_offline_endpoint_button")
                        ) {
                            Text(
                                stringResource(R.string.chat_endpoint_config),
                                style = MaterialTheme.typography.labelSmall,
                                color = cs.onErrorContainer
                            )
                        }
                    }
                }
            }
        }

        // 3. Messages Stream or Starter Empty State
        if (uiState.messages.isEmpty()) {
            Column(
                modifier = Modifier
                    .weight(1f)
                    .fillMaxWidth()
                    .padding(horizontal = 20.dp),
                verticalArrangement = Arrangement.Center,
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                Box(
                    modifier = Modifier
                        .size(56.dp)
                        .clip(RoundedCornerShape(16.dp))
                        .background(cs.secondaryContainer),
                    contentAlignment = Alignment.Center
                ) {
                    Icon(
                        imageVector = Icons.Outlined.AutoAwesome,
                        contentDescription = null,
                        tint = cs.secondary,
                        modifier = Modifier.size(28.dp)
                    )
                }
                Spacer(Modifier.height(14.dp))
                Text(
                    text = stringResource(R.string.chat_empty_title),
                    style = MaterialTheme.typography.titleLarge,
                    color = cs.onSurface
                )
                Spacer(Modifier.height(6.dp))
                Text(
                    text = stringResource(R.string.chat_empty_subtitle),
                    style = MaterialTheme.typography.bodyMedium,
                    color = cs.onSurfaceVariant
                )
                Spacer(Modifier.height(18.dp))
                Row(
                    modifier = Modifier.horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    val starters = listOf(
                        "Check cluster node status and layer shards",
                        "Explain KV cache quantization in 3 bullets",
                        "Write a concise Python HTTP health probe"
                    )
                    starters.forEachIndexed { idx, starter ->
                        AssistChip(
                            onClick = { onSendPrompt(starter) },
                            label = { Text(starter, style = MaterialTheme.typography.labelSmall) },
                            modifier = Modifier.testTag("starter_chip_$idx")
                        )
                    }
                }
            }
        } else {
            LazyColumn(
                state = listState,
                modifier = Modifier
                    .weight(1f)
                    .fillMaxWidth()
                    .testTag("chat_messages_list"),
                contentPadding = PaddingValues(horizontal = 16.dp, vertical = 10.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp)
            ) {
                items(uiState.messages, key = { it.id }) { msg ->
                    ChatMessageBubble(
                        message = msg,
                        isStreamingTail = uiState.isStreamingChat && msg.id == uiState.messages.lastOrNull()?.id && msg.role == "assistant",
                        onCopy = {
                            val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                            cm.setPrimaryClip(ClipData.newPlainText("Silica Message", msg.content))
                        },
                        onRetry = if (msg.isError) {
                            {
                                val lastUser = uiState.messages.lastOrNull { it.role == "user" }?.content
                                if (!lastUser.isNullOrBlank()) onSendPrompt(lastUser)
                            }
                        } else null
                    )
                }
            }
        }

        // 4. Bottom Composer Bar
        Surface(
            color = cs.surfaceContainer,
            border = BorderStroke(1.dp, cs.outlineVariant),
            modifier = Modifier.fillMaxWidth()
        ) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 12.dp, vertical = 10.dp),
                verticalAlignment = Alignment.Bottom,
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                OutlinedTextField(
                    value = promptText,
                    onValueChange = { promptText = it },
                    placeholder = {
                        Text(
                            text = stringResource(R.string.chat_composer_placeholder),
                            style = MaterialTheme.typography.bodyMedium,
                            color = cs.onSurfaceVariant
                        )
                    },
                    maxLines = 4,
                    shape = MaterialTheme.shapes.medium,
                    colors = OutlinedTextFieldDefaults.colors(
                        focusedBorderColor = cs.secondary,
                        unfocusedBorderColor = cs.outlineVariant,
                        focusedContainerColor = cs.surfaceContainerLow,
                        unfocusedContainerColor = cs.surfaceContainerLow
                    ),
                    modifier = Modifier
                        .weight(1f)
                        .testTag("chat_composer_input")
                )

                if (uiState.isStreamingChat) {
                    FilledIconButton(
                        onClick = onStopStreaming,
                        colors = IconButtonDefaults.filledIconButtonColors(
                            containerColor = cs.error,
                            contentColor = cs.onError
                        ),
                        modifier = Modifier
                            .size(48.dp)
                            .testTag("chat_stop_button")
                    ) {
                        Icon(
                            imageVector = Icons.Outlined.Stop,
                            contentDescription = stringResource(R.string.chat_stop)
                        )
                    }
                } else {
                    FilledIconButton(
                        onClick = {
                            if (promptText.isNotBlank()) {
                                val outgoing = promptText
                                promptText = ""
                                onSendPrompt(outgoing)
                            }
                        },
                        enabled = promptText.isNotBlank(),
                        colors = IconButtonDefaults.filledIconButtonColors(
                            containerColor = cs.primary,
                            contentColor = cs.onPrimary,
                            disabledContainerColor = cs.surfaceContainerHigh,
                            disabledContentColor = cs.onSurfaceVariant
                        ),
                        modifier = Modifier
                            .size(48.dp)
                            .testTag("chat_send_button")
                    ) {
                        Icon(
                            imageVector = Icons.AutoMirrored.Outlined.Send,
                            contentDescription = stringResource(R.string.chat_send)
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun ChatMessageBubble(
    message: ChatMessageEntity,
    isStreamingTail: Boolean,
    onCopy: () -> Unit,
    onRetry: (() -> Unit)?
) {
    val cs = MaterialTheme.colorScheme
    val isUser = message.role == "user"
    val bubbleColor = when {
        message.isError -> cs.errorContainer.copy(alpha = 0.65f)
        isUser -> cs.primaryContainer
        else -> cs.surfaceContainer
    }
    val borderColor = when {
        message.isError -> cs.error.copy(alpha = 0.6f)
        isUser -> cs.primary.copy(alpha = 0.5f)
        else -> cs.outlineVariant
    }

    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = if (isUser) Arrangement.End else Arrangement.Start
    ) {
        Surface(
            shape = RoundedCornerShape(
                topStart = 16.dp,
                topEnd = 16.dp,
                bottomStart = if (isUser) 16.dp else 4.dp,
                bottomEnd = if (isUser) 4.dp else 16.dp
            ),
            color = bubbleColor,
            border = BorderStroke(1.dp, borderColor),
            modifier = Modifier.widthIn(max = 330.dp)
        ) {
            Column(
                modifier = Modifier.padding(horizontal = 13.dp, vertical = 10.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp)
            ) {
                val displayText = if (message.content.isBlank() && isStreamingTail) {
                    "Streaming from cluster…"
                } else {
                    message.content
                }
                Text(
                    text = displayText,
                    style = MaterialTheme.typography.bodyLarge,
                    color = when {
                        message.isError -> cs.onErrorContainer
                        isUser -> cs.onPrimaryContainer
                        else -> cs.onSurface
                    }
                )

                if (!isUser) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        val metrics = buildString {
                            if (message.modelId.isNotBlank()) append(message.modelId)
                            if (message.tokPerSec > 0f) {
                                if (isNotEmpty()) append(" • ")
                                append("${"%.1f".format(message.tokPerSec)} tok/s")
                            }
                            if (message.activeNodes > 0) {
                                if (isNotEmpty()) append(" • ")
                                append("${message.activeNodes}N")
                            }
                            if (isStreamingTail) append(" • LIVE")
                        }
                        Text(
                            text = metrics.ifBlank { "Cluster Reply" },
                            style = MaterialTheme.typography.labelSmall,
                            color = if (message.isError) cs.onErrorContainer else cs.secondary,
                            modifier = Modifier.weight(1f),
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis
                        )
                        Row {
                            if (onRetry != null) {
                                IconButton(
                                    onClick = onRetry,
                                    modifier = Modifier.size(32.dp)
                                ) {
                                    Icon(
                                        imageVector = Icons.Outlined.Refresh,
                                        contentDescription = stringResource(R.string.btn_retry),
                                        tint = cs.onErrorContainer,
                                        modifier = Modifier.size(16.dp)
                                    )
                                }
                            }
                            IconButton(
                                onClick = onCopy,
                                modifier = Modifier.size(32.dp)
                            ) {
                                Icon(
                                    imageVector = Icons.Outlined.ContentCopy,
                                    contentDescription = stringResource(R.string.cmd_copy_logs),
                                    tint = cs.onSurfaceVariant,
                                    modifier = Modifier.size(15.dp)
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}
