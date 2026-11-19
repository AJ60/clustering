package com.example.ui.components

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateRectAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.outlined.Gesture
import androidx.compose.material.icons.outlined.TouchApp
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import com.example.R
import kotlin.math.roundToInt

enum class CoachMarkStep {
    CANVAS,
    GESTURE_CONTROLS,
    RUN_BUTTON
}

data class CoachMarkTargets(
    val canvasBounds: Rect = Rect.Zero,
    val gestureControlsBounds: Rect = Rect.Zero,
    val runButtonBounds: Rect = Rect.Zero
)

/**
 * Interactive first-launch spotlight Coach-Mark Overlay that guides new users through:
 * 1. The 2D Clustering Canvas & live Silhouette/Inertia overlay
 * 2. Touch & Gesture Controls (Tap Add, Erase, Clear)
 * 3. The Run Clustering button (with an interactive "Run & Finish" action)
 *
 * Uses dynamic [onGloballyPositioned] target bounds and [BoxWithConstraints] so spotlights
 * and callout cards stay cleanly positioned across phones, foldables, and tablets.
 */
@Composable
fun InteractiveCoachMarkOverlay(
    visible: Boolean,
    targets: CoachMarkTargets,
    onInteractiveDropSamplePoint: () -> Unit,
    onInteractiveRunClustering: () -> Unit,
    onComplete: () -> Unit,
    onSkip: () -> Unit,
    modifier: Modifier = Modifier
) {
    var currentStepIndex by remember(visible) { mutableIntStateOf(0) }
    val steps = CoachMarkStep.entries
    val currentStep = steps[currentStepIndex.coerceIn(0, steps.lastIndex)]

    BackHandler(enabled = visible) {
        onSkip()
    }

    AnimatedVisibility(
        visible = visible,
        enter = fadeIn(tween(240)),
        exit = fadeOut(tween(200)),
        modifier = modifier.fillMaxSize()
    ) {
        BoxWithConstraints(
            modifier = Modifier
                .fillMaxSize()
                .testTag("coach_mark_overlay_root")
        ) {
            val density = LocalDensity.current
            val containerWidthPx = with(density) { maxWidth.toPx() }
            val containerHeightPx = with(density) { maxHeight.toPx() }
            val padPx = with(density) { 8.dp.toPx() }
            val cornerPx = with(density) { 18.dp.toPx() }

            val rawTarget = when (currentStep) {
                CoachMarkStep.CANVAS -> targets.canvasBounds
                CoachMarkStep.GESTURE_CONTROLS -> targets.gestureControlsBounds
                CoachMarkStep.RUN_BUTTON -> targets.runButtonBounds
            }

            // Fallback centered spotlight if a target hasn't been measured yet
            val effectiveTarget = if (rawTarget.width > 4f && rawTarget.height > 4f) {
                Rect(
                    left = (rawTarget.left - padPx).coerceAtLeast(6f),
                    top = (rawTarget.top - padPx).coerceAtLeast(6f),
                    right = (rawTarget.right + padPx).coerceAtMost(containerWidthPx - 6f),
                    bottom = (rawTarget.bottom + padPx).coerceAtMost(containerHeightPx - 6f)
                )
            } else {
                Rect(
                    left = containerWidthPx * 0.1f,
                    top = containerHeightPx * 0.18f,
                    right = containerWidthPx * 0.9f,
                    bottom = containerHeightPx * 0.45f
                )
            }

            val animatedRect by animateRectAsState(
                targetValue = effectiveTarget,
                animationSpec = tween(durationMillis = 320, easing = FastOutSlowInEasing),
                label = "coach_mark_spotlight_rect"
            )

            val infiniteTransition = rememberInfiniteTransition(label = "coach_mark_pulse")
            val pulseFraction by infiniteTransition.animateFloat(
                initialValue = 0f,
                targetValue = 1f,
                animationSpec = infiniteRepeatable(
                    animation = tween(durationMillis = 1200, easing = FastOutSlowInEasing),
                    repeatMode = RepeatMode.Reverse
                ),
                label = "coach_mark_pulse_value"
            )

            val primaryColor = MaterialTheme.colorScheme.primary
            val scrimColor = Color(0xCC090D16)

            // Legacy-GPU-safe spotlight scrim: draws 4 translucent surround rectangles around
            // animatedRect instead of CompositingStrategy.Offscreen + BlendMode.Clear, avoiding
            // black-box driver glitches on older Mali-400/PowerVR/Adreno 3xx-5xx GLES 2.0/3.0 GPUs.
            Canvas(
                modifier = Modifier
                    .fillMaxSize()
                    .pointerInput(currentStep, effectiveTarget) {
                        detectTapGestures { tapOffset ->
                            // Interactive spotlight tap: tapping inside the highlighted area performs the step action!
                            if (effectiveTarget.contains(tapOffset)) {
                                when (currentStep) {
                                    CoachMarkStep.CANVAS -> {
                                        onInteractiveDropSamplePoint()
                                        currentStepIndex = 1
                                    }
                                    CoachMarkStep.GESTURE_CONTROLS -> {
                                        currentStepIndex = 2
                                    }
                                    CoachMarkStep.RUN_BUTTON -> {
                                        onInteractiveRunClustering()
                                        onComplete()
                                    }
                                }
                            }
                        }
                    }
            ) {
                val left = animatedRect.left.coerceIn(0f, size.width)
                val top = animatedRect.top.coerceIn(0f, size.height)
                val right = animatedRect.right.coerceIn(left, size.width)
                val bottom = animatedRect.bottom.coerceIn(top, size.height)

                // Top scrim strip
                if (top > 0f) {
                    drawRect(
                        color = scrimColor,
                        topLeft = Offset.Zero,
                        size = Size(size.width, top)
                    )
                }
                // Bottom scrim strip
                if (bottom < size.height) {
                    drawRect(
                        color = scrimColor,
                        topLeft = Offset(0f, bottom),
                        size = Size(size.width, size.height - bottom)
                    )
                }
                // Left scrim strip
                if (left > 0f && bottom > top) {
                    drawRect(
                        color = scrimColor,
                        topLeft = Offset(0f, top),
                        size = Size(left, bottom - top)
                    )
                }
                // Right scrim strip
                if (right < size.width && bottom > top) {
                    drawRect(
                        color = scrimColor,
                        topLeft = Offset(right, top),
                        size = Size(size.width - right, bottom - top)
                    )
                }

                // Pulsing outer ring
                val ringExpand = 4f + pulseFraction * 8f
                drawRoundRect(
                    color = primaryColor.copy(alpha = 0.35f + (1f - pulseFraction) * 0.45f),
                    topLeft = Offset(left - ringExpand, top - ringExpand),
                    size = Size(
                        (right - left) + ringExpand * 2f,
                        (bottom - top) + ringExpand * 2f
                    ),
                    cornerRadius = CornerRadius(cornerPx + ringExpand, cornerPx + ringExpand),
                    style = Stroke(width = 3.5f)
                )

                // Crisp inner accent outline
                drawRoundRect(
                    color = primaryColor,
                    topLeft = Offset(left, top),
                    size = Size(right - left, bottom - top),
                    cornerRadius = CornerRadius(cornerPx, cornerPx),
                    style = Stroke(width = 2.5f)
                )
            }

            // Decide whether callout card goes below or above the spotlight so it never clips off-screen
            val estimatedCardHeightPx = with(density) { 235.dp.toPx() }
            val marginPx = with(density) { 14.dp.toPx() }
            val spaceBelow = containerHeightPx - animatedRect.bottom
            val cardTopPx = if (spaceBelow >= estimatedCardHeightPx + marginPx) {
                (animatedRect.bottom + marginPx).coerceAtMost(containerHeightPx - estimatedCardHeightPx - marginPx)
            } else {
                (animatedRect.top - estimatedCardHeightPx - marginPx).coerceAtLeast(marginPx)
            }

            val (stepIcon: ImageVector, stepTitle: String, stepBody: String, tapHint: String) = when (currentStep) {
                CoachMarkStep.CANVAS -> Quadruple(
                    Icons.Outlined.TouchApp,
                    stringResource(R.string.coach_step1_title),
                    stringResource(R.string.coach_step1_body),
                    stringResource(R.string.coach_step1_hint)
                )
                CoachMarkStep.GESTURE_CONTROLS -> Quadruple(
                    Icons.Outlined.Gesture,
                    stringResource(R.string.coach_step2_title),
                    stringResource(R.string.coach_step2_body),
                    stringResource(R.string.coach_step2_hint)
                )
                CoachMarkStep.RUN_BUTTON -> Quadruple(
                    Icons.Filled.PlayArrow,
                    stringResource(R.string.coach_step3_title),
                    stringResource(R.string.coach_step3_body),
                    stringResource(R.string.coach_step3_hint)
                )
            }

            // Floating Material 3 Coach-Mark Callout Card
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .offset { IntOffset(0, cardTopPx.roundToInt()) }
                    .padding(horizontal = 16.dp),
                contentAlignment = Alignment.TopCenter
            ) {
                Surface(
                    shape = RoundedCornerShape(22.dp),
                    color = MaterialTheme.colorScheme.surface,
                    tonalElevation = 8.dp,
                    shadowElevation = 12.dp,
                    modifier = Modifier
                        .fillMaxWidth()
                        .widthIn(max = 520.dp)
                        .testTag("coach_mark_card_step_${currentStepIndex + 1}")
                ) {
                    Column(
                        modifier = Modifier.padding(18.dp),
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
                                Surface(
                                    shape = CircleShape,
                                    color = MaterialTheme.colorScheme.primaryContainer
                                ) {
                                    Icon(
                                        imageVector = stepIcon,
                                        contentDescription = null,
                                        tint = MaterialTheme.colorScheme.primary,
                                        modifier = Modifier
                                            .padding(8.dp)
                                            .size(20.dp)
                                    )
                                }
                                Column {
                                    Text(
                                        text = "Quick Tour • Step ${currentStepIndex + 1} of ${steps.size}",
                                        style = MaterialTheme.typography.labelSmall,
                                        fontWeight = FontWeight.Bold,
                                        color = MaterialTheme.colorScheme.primary
                                    )
                                    Text(
                                        text = stepTitle,
                                        style = MaterialTheme.typography.titleMedium,
                                        fontWeight = FontWeight.Bold,
                                        color = MaterialTheme.colorScheme.onSurface
                                    )
                                }
                            }

                            TextButton(
                                onClick = onSkip,
                                modifier = Modifier
                                    .heightIn(min = 48.dp)
                                    .testTag("coach_mark_skip_button")
                            ) {
                                Text(stringResource(R.string.coach_action_skip))
                            }
                        }

                        Text(
                            text = stepBody,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )

                        Surface(
                            shape = RoundedCornerShape(10.dp),
                            color = MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.45f),
                            modifier = Modifier.fillMaxWidth()
                        ) {
                            Text(
                                text = tapHint,
                                style = MaterialTheme.typography.labelSmall,
                                fontWeight = FontWeight.Medium,
                                color = MaterialTheme.colorScheme.onPrimaryContainer,
                                modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp)
                            )
                        }

                        // Step progress dots + Navigation buttons
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Row(
                                horizontalArrangement = Arrangement.spacedBy(6.dp),
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                steps.indices.forEach { idx ->
                                    Box(
                                        modifier = Modifier
                                            .height(8.dp)
                                            .width(if (idx == currentStepIndex) 22.dp else 8.dp)
                                            .clip(CircleShape)
                                            .background(
                                                if (idx == currentStepIndex) {
                                                    MaterialTheme.colorScheme.primary
                                                } else {
                                                    MaterialTheme.colorScheme.outline.copy(alpha = 0.4f)
                                                }
                                            )
                                    )
                                }
                            }

                            Row(
                                horizontalArrangement = Arrangement.spacedBy(8.dp),
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                if (currentStepIndex > 0) {
                                    OutlinedButton(
                                        onClick = { currentStepIndex -= 1 },
                                        modifier = Modifier
                                            .heightIn(min = 48.dp)
                                            .testTag("coach_mark_back_button")
                                    ) {
                                        Text(stringResource(R.string.coach_action_back))
                                    }
                                }

                                Button(
                                    onClick = {
                                        when (currentStep) {
                                            CoachMarkStep.CANVAS -> currentStepIndex = 1
                                            CoachMarkStep.GESTURE_CONTROLS -> currentStepIndex = 2
                                            CoachMarkStep.RUN_BUTTON -> {
                                                onInteractiveRunClustering()
                                                onComplete()
                                            }
                                        }
                                    },
                                    modifier = Modifier
                                        .heightIn(min = 48.dp)
                                        .testTag("coach_mark_next_button")
                                ) {
                                    if (currentStep == CoachMarkStep.RUN_BUTTON) {
                                        Icon(
                                            imageVector = Icons.Filled.PlayArrow,
                                            contentDescription = null,
                                            modifier = Modifier.size(18.dp)
                                        )
                                        Spacer(modifier = Modifier.width(4.dp))
                                        Text(stringResource(R.string.coach_action_run_finish))
                                    } else {
                                        Text(stringResource(R.string.coach_action_next))
                                        Spacer(modifier = Modifier.width(4.dp))
                                        Icon(
                                            imageVector = Icons.AutoMirrored.Filled.ArrowForward,
                                            contentDescription = null,
                                            modifier = Modifier.size(18.dp)
                                        )
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

private data class Quadruple<A, B, C, D>(
    val first: A,
    val second: B,
    val third: C,
    val fourth: D
)
