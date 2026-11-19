package com.example.ui.components

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CenterFocusStrong
import androidx.compose.material.icons.outlined.GridOn
import androidx.compose.material.icons.outlined.Hub
import androidx.compose.material.icons.outlined.TouchApp
import androidx.compose.material3.FilledTonalIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.TextMeasurer
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.R
import com.example.model.AlgorithmType
import com.example.model.CanvasToolMode
import com.example.model.CentroidState
import com.example.model.DataPoint
import com.example.model.PointRole
import com.example.ui.theme.ClusterColors
import com.example.ui.theme.NoisePointColor
import kotlin.math.min
import kotlin.math.sqrt

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.height
import androidx.compose.material.icons.automirrored.outlined.TrendingFlat
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.Insights
import androidx.compose.material.icons.outlined.StickyNote2
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import com.example.model.ClusterAnnotation
import java.util.Locale
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.sin

private enum class CanvasQualityDisplayMode(val label: String) {
    BOTH("Both"),
    SILHOUETTE("Silhouette"),
    INERTIA("Inertia")
}

private val CentroidGlideEasing = CubicBezierEasing(0.22f, 1.0f, 0.36f, 1.0f)

/**
 * Pure interpolation helper for smooth K-Means centroid glide between iterations.
 */
object CentroidInterpolator {
    fun interpolate(
        previous: List<CentroidState>,
        target: List<CentroidState>,
        progress: Float
    ): List<CentroidState> {
        val t = progress.coerceIn(0f, 1f)
        if (previous.isEmpty() || t >= 0.999f) return target
        val prevById = previous.associateBy { it.clusterId }
        return target.map { dest ->
            val prev = prevById[dest.clusterId]
            if (prev != null) {
                dest.copy(
                    x = prev.x + (dest.x - prev.x) * t,
                    y = prev.y + (dest.y - prev.y) * t
                )
            } else {
                dest
            }
        }
    }

    fun computeTotalShift(
        previous: List<CentroidState>,
        target: List<CentroidState>
    ): Float {
        if (previous.isEmpty() || target.isEmpty()) return 0f
        val prevById = previous.associateBy { it.clusterId }
        var total = 0f
        for (dest in target) {
            val prev = prevById[dest.clusterId] ?: continue
            val dx = dest.x - prev.x
            val dy = dest.y - prev.y
            total += sqrt(dx * dx + dy * dy)
        }
        return total
    }
}

/**
 * Pure hit-detection helper that resolves which cluster area or existing annotation
 * a user long-pressed in normalized [0f, 1f] world space.
 */
object ClusterAreaHitDetector {

    fun findExistingAnnotationAt(
        worldX: Float,
        worldY: Float,
        annotations: List<ClusterAnnotation>,
        hitRadius: Float = 0.065f
    ): ClusterAnnotation? {
        val maxDistSq = hitRadius * hitRadius
        var best: ClusterAnnotation? = null
        var bestDistSq = maxDistSq
        for (ann in annotations) {
            val dx = ann.x - worldX
            val dy = ann.y - worldY
            val d2 = dx * dx + dy * dy
            if (d2 <= bestDistSq) {
                bestDistSq = d2
                best = ann
            }
        }
        return best
    }

    fun findClusterAt(
        worldX: Float,
        worldY: Float,
        algorithm: AlgorithmType,
        points: List<DataPoint>,
        centroids: List<CentroidState>,
        dbscanRadius: Float = 0.16f
    ): Int {
        if (algorithm == AlgorithmType.KMEANS && centroids.isNotEmpty()) {
            var nearestId = centroids.first().clusterId
            var minDistSq = Float.MAX_VALUE
            for (centroid in centroids) {
                val dx = centroid.x - worldX
                val dy = centroid.y - worldY
                val d2 = dx * dx + dy * dy
                if (d2 < minDistSq) {
                    minDistSq = d2
                    nearestId = centroid.clusterId
                }
            }
            return nearestId
        }

        // For DBSCAN (or K-Means before centroids exist), resolve nearest clustered point within radius
        val maxDistSq = dbscanRadius * dbscanRadius
        var bestClusterId = -1
        var bestDistSq = maxDistSq
        for (pt in points) {
            if (pt.clusterId < 0) continue
            val dx = pt.x - worldX
            val dy = pt.y - worldY
            val d2 = dx * dx + dy * dy
            if (d2 <= bestDistSq) {
                bestDistSq = d2
                bestClusterId = pt.clusterId
            }
        }
        if (bestClusterId >= 0) return bestClusterId

        // Fallback to nearest centroid within generous radius if points are sparse
        for (centroid in centroids) {
            val dx = centroid.x - worldX
            val dy = centroid.y - worldY
            val d2 = dx * dx + dy * dy
            if (d2 <= bestDistSq) {
                bestDistSq = d2
                bestClusterId = centroid.clusterId
            }
        }
        return bestClusterId
    }
}

@Composable
fun InteractiveClusterCanvas(
    points: List<DataPoint>,
    centroids: List<CentroidState>,
    algorithm: AlgorithmType,
    toolMode: CanvasToolMode,
    showGrid: Boolean,
    showVoronoi: Boolean,
    showTrails: Boolean,
    showEpsilonRings: Boolean,
    epsilonRadius: Float,
    isDarkTheme: Boolean,
    onAddPoint: (Float, Float) -> Unit,
    onBrushPoint: (Float, Float) -> Unit,
    onErasePoint: (Float, Float) -> Unit,
    onToggleGrid: () -> Unit,
    modifier: Modifier = Modifier,
    previousCentroids: List<CentroidState> = emptyList(),
    lastAddedPointId: Int? = null,
    showSpiderLines: Boolean = true,
    onToggleSpiderLines: () -> Unit = {},
    silhouetteScore: Float = 0f,
    inertiaWcss: Float = 0f,
    noiseCount: Int = 0,
    developerModeEnabled: Boolean = false,
    legacyGraphicsMode: Boolean = false,
    currentIteration: Int = 0,
    totalIterations: Int = 1,
    isConverged: Boolean = false,
    isPlaying: Boolean = false,
    transitionNonce: Int = 0,
    annotations: List<ClusterAnnotation> = emptyList(),
    onLongPressClusterArea: (
        clusterId: Int,
        worldX: Float,
        worldY: Float,
        existingAnnotation: ClusterAnnotation?
    ) -> Unit = { _, _, _, _ -> }
) {
    var zoom by remember { mutableFloatStateOf(1f) }
    var panOffset by remember { mutableStateOf(Offset.Zero) }
    var lastTouchCoord by remember { mutableStateOf<Pair<Float, Float>?>(null) }
    var qualityOverlayModeIndex by remember { mutableIntStateOf(0) }
    val hapticFeedback = LocalHapticFeedback.current
    val latestPoints by rememberUpdatedState(points)
    val latestCentroids by rememberUpdatedState(centroids)
    val latestAnnotations by rememberUpdatedState(annotations)
    val latestAlgorithm by rememberUpdatedState(algorithm)
    val latestOnLongPressCluster by rememberUpdatedState(onLongPressClusterArea)
    val qualityDisplayMode = CanvasQualityDisplayMode.entries[
        qualityOverlayModeIndex % CanvasQualityDisplayMode.entries.size
    ]

    // Dedicated smooth glide animation for K-Means centroid movement between iterations
    val centroidGlideProgress = remember { Animatable(1f) }
    LaunchedEffect(algorithm, currentIteration, transitionNonce, centroids) {
        if (algorithm == AlgorithmType.KMEANS && previousCentroids.isNotEmpty() && centroids.isNotEmpty()) {
            val shift = CentroidInterpolator.computeTotalShift(previousCentroids, centroids)
            if (shift > 0.0005f) {
                centroidGlideProgress.snapTo(0f)
                centroidGlideProgress.animateTo(
                    targetValue = 1f,
                    animationSpec = tween(
                        durationMillis = if (isPlaying) 480 else 440,
                        easing = CentroidGlideEasing
                    )
                )
            } else {
                centroidGlideProgress.snapTo(1f)
            }
        } else {
            centroidGlideProgress.snapTo(1f)
        }
    }

    // Touch ripple pulse when the user drops a new data point onto the canvas
    val tapPulseProgress = remember { Animatable(1f) }
    LaunchedEffect(lastAddedPointId, points.size) {
        if (lastAddedPointId != null) {
            tapPulseProgress.snapTo(0f)
            tapPulseProgress.animateTo(
                targetValue = 1f,
                animationSpec = tween(durationMillis = 420, easing = FastOutSlowInEasing)
            )
        } else {
            tapPulseProgress.snapTo(1f)
        }
    }

    val totalIterationShift = remember(previousCentroids, centroids) {
        CentroidInterpolator.computeTotalShift(previousCentroids, centroids)
    }

    val textMeasurer = rememberTextMeasurer()
    val surfaceColor = MaterialTheme.colorScheme.surface
    val gridColor = MaterialTheme.colorScheme.outline.copy(alpha = if (isDarkTheme) 0.28f else 0.35f)
    val axisColor = MaterialTheme.colorScheme.primary.copy(alpha = 0.40f)
    val centroidRingColor = if (isDarkTheme) Color.White else Color(0xFF0F172A)

    fun screenToWorld(offset: Offset, width: Float, height: Float): Pair<Float, Float> {
        if (width <= 1f || height <= 1f) return 0.5f to 0.5f
        val wx = ((offset.x - panOffset.x) / (width * zoom)).coerceIn(0.01f, 0.99f)
        val wy = ((offset.y - panOffset.y) / (height * zoom)).coerceIn(0.01f, 0.99f)
        return wx to wy
    }

    fun worldToScreen(wx: Float, wy: Float, width: Float, height: Float): Offset {
        return Offset(
            x = wx * width * zoom + panOffset.x,
            y = wy * height * zoom + panOffset.y
        )
    }

    Box(
        modifier = modifier
            .clip(RoundedCornerShape(20.dp))
            .background(surfaceColor)
            .border(
                width = 1.dp,
                color = MaterialTheme.colorScheme.outline.copy(alpha = 0.45f),
                shape = RoundedCornerShape(20.dp)
            )
    ) {
        Canvas(
            modifier = Modifier
                .fillMaxSize()
                .testTag("clustering_scatter_canvas")
                .pointerInput(toolMode, zoom, panOffset) {
                    fun handleLongPress(pressOffset: Offset) {
                        val (wx, wy) = screenToWorld(
                            pressOffset,
                            size.width.toFloat(),
                            size.height.toFloat()
                        )
                        lastTouchCoord = wx to wy
                        hapticFeedback.performHapticFeedback(HapticFeedbackType.LongPress)
                        val existing = ClusterAreaHitDetector.findExistingAnnotationAt(
                            worldX = wx,
                            worldY = wy,
                            annotations = latestAnnotations
                        )
                        val clusterId = existing?.clusterId ?: ClusterAreaHitDetector.findClusterAt(
                            worldX = wx,
                            worldY = wy,
                            algorithm = latestAlgorithm,
                            points = latestPoints,
                            centroids = latestCentroids
                        )
                        latestOnLongPressCluster(
                            clusterId,
                            existing?.x ?: wx,
                            existing?.y ?: wy,
                            existing
                        )
                    }

                    if (toolMode == CanvasToolMode.PAN) {
                        detectTransformGestures { _, pan, gestureZoom, _ ->
                            val newZoom = (zoom * gestureZoom).coerceIn(0.75f, 3.5f)
                            zoom = newZoom
                            panOffset += pan
                        }
                    } else {
                        detectTapGestures(
                            onLongPress = { pressOffset -> handleLongPress(pressOffset) },
                            onTap = { tapOffset ->
                                val (wx, wy) = screenToWorld(
                                    tapOffset,
                                    size.width.toFloat(),
                                    size.height.toFloat()
                                )
                                lastTouchCoord = wx to wy
                                when (toolMode) {
                                    CanvasToolMode.ADD -> onAddPoint(wx, wy)
                                    CanvasToolMode.BRUSH -> onBrushPoint(wx, wy)
                                    CanvasToolMode.ERASE -> onErasePoint(wx, wy)
                                    CanvasToolMode.PAN -> {}
                                }
                            }
                        )
                    }
                }
                .pointerInput(toolMode, zoom, panOffset) {
                    if (toolMode == CanvasToolMode.PAN) {
                        detectTapGestures(
                            onLongPress = { pressOffset ->
                                val (wx, wy) = screenToWorld(
                                    pressOffset,
                                    size.width.toFloat(),
                                    size.height.toFloat()
                                )
                                lastTouchCoord = wx to wy
                                hapticFeedback.performHapticFeedback(HapticFeedbackType.LongPress)
                                val existing = ClusterAreaHitDetector.findExistingAnnotationAt(
                                    worldX = wx,
                                    worldY = wy,
                                    annotations = latestAnnotations
                                )
                                val clusterId = existing?.clusterId ?: ClusterAreaHitDetector.findClusterAt(
                                    worldX = wx,
                                    worldY = wy,
                                    algorithm = latestAlgorithm,
                                    points = latestPoints,
                                    centroids = latestCentroids
                                )
                                latestOnLongPressCluster(
                                    clusterId,
                                    existing?.x ?: wx,
                                    existing?.y ?: wy,
                                    existing
                                )
                            }
                        )
                    } else {
                        detectDragGestures { change, _ ->
                            change.consume()
                            val (wx, wy) = screenToWorld(
                                change.position,
                                size.width.toFloat(),
                                size.height.toFloat()
                            )
                            lastTouchCoord = wx to wy
                            when (toolMode) {
                                CanvasToolMode.ADD, CanvasToolMode.BRUSH -> onBrushPoint(wx, wy)
                                CanvasToolMode.ERASE -> onErasePoint(wx, wy)
                                CanvasToolMode.PAN -> {}
                            }
                        }
                    }
                }
        ) {
            val w = size.width
            val h = size.height
            if (w <= 0f || h <= 0f) return@Canvas

            val glideT = centroidGlideProgress.value.coerceIn(0f, 1f)
            val animT = tapPulseProgress.value.coerceIn(0f, 1f)
            val prevCentroidMap = previousCentroids.associateBy { it.clusterId }

            // Smoothly interpolated centroid positions so Voronoi regions, spider lines,
            // trails, and centroid markers all glide in unison between K-Means iterations.
            val liveCentroids = CentroidInterpolator.interpolate(
                previous = previousCentroids,
                target = centroids,
                progress = glideT
            )
            val liveCentroidById = liveCentroids.associateBy { it.clusterId }

            // 1. Optional Voronoi cells for K-Means (reduced grid on legacy GPUs to prevent overdraw)
            if (algorithm == AlgorithmType.KMEANS && showVoronoi && liveCentroids.isNotEmpty()) {
                drawVoronoiRegions(
                    centroids = liveCentroids,
                    width = w,
                    height = h,
                    zoom = zoom,
                    panOffset = panOffset,
                    isDarkTheme = isDarkTheme,
                    legacyGraphicsMode = legacyGraphicsMode
                )
            }

            // 2. Precision 2D Coordinate Grid
            if (showGrid) {
                val divisions = 10
                for (i in 1 until divisions) {
                    val frac = i.toFloat() / divisions.toFloat()
                    val screenPos = worldToScreen(frac, frac, w, h)
                    val isCenter = i == 5
                    val strokeColor = if (isCenter) axisColor else gridColor
                    val strokeW = if (isCenter) 1.6f else 1f

                    if (screenPos.x in 0f..w) {
                        drawLine(
                            color = strokeColor,
                            start = Offset(screenPos.x, 0f),
                            end = Offset(screenPos.x, h),
                            strokeWidth = strokeW
                        )
                    }
                    if (screenPos.y in 0f..h) {
                        drawLine(
                            color = strokeColor,
                            start = Offset(0f, screenPos.y),
                            end = Offset(w, screenPos.y),
                            strokeWidth = strokeW
                        )
                    }
                }
            }

            // 3. DBSCAN Epsilon neighborhood rings around Core points
            if (algorithm == AlgorithmType.DBSCAN && showEpsilonRings && points.isNotEmpty()) {
                val epsScreenRadius = epsilonRadius * min(w, h) * zoom
                val corePoints = points.filter { it.role == PointRole.CORE }
                val ringBudget = if (legacyGraphicsMode) 28 else 70
                val stepStride = (corePoints.size / ringBudget).coerceAtLeast(1)
                for (idx in corePoints.indices step stepStride) {
                    val pt = corePoints[idx]
                    val center = worldToScreen(pt.x, pt.y, w, h)
                    val cColor = if (pt.clusterId >= 0) {
                        ClusterColors[pt.clusterId % ClusterColors.size]
                    } else {
                        Color(0xFF38BDF8)
                    }
                    drawCircle(
                        color = cColor.copy(alpha = if (isDarkTheme) 0.08f else 0.10f),
                        radius = epsScreenRadius,
                        center = center
                    )
                    drawCircle(
                        color = cColor.copy(alpha = if (isDarkTheme) 0.26f else 0.32f),
                        radius = epsScreenRadius,
                        center = center,
                        style = Stroke(
                            width = 1.2f,
                            pathEffect = PathEffect.dashPathEffect(floatArrayOf(8f, 6f), 0f)
                        )
                    )
                }
            }

            // 4. Real-Time Point-to-Centroid Spider / Assignment Lines
            if (showSpiderLines && liveCentroids.isNotEmpty()) {
                val lineStride = if (legacyGraphicsMode && points.size > 120) 2 else 1
                for (ptIdx in points.indices step lineStride) {
                    val pt = points[ptIdx]
                    if (pt.clusterId < 0) continue
                    val targetCentroid = liveCentroidById[pt.clusterId] ?: continue
                    val ptPos = worldToScreen(pt.x, pt.y, w, h)
                    val cPos = worldToScreen(targetCentroid.x, targetCentroid.y, w, h)
                    val color = ClusterColors[pt.clusterId % ClusterColors.size]
                    val isNewestPoint = pt.id == lastAddedPointId

                    drawLine(
                        color = color.copy(alpha = if (isNewestPoint) 0.85f else 0.22f),
                        start = ptPos,
                        end = cPos,
                        strokeWidth = if (isNewestPoint) 3.2f else 1.2f,
                        pathEffect = if (isNewestPoint) {
                            PathEffect.dashPathEffect(floatArrayOf(10f, 6f), 0f)
                        } else {
                            null
                        }
                    )
                }
            }

            // 5. K-Means Centroid Movement Trails & Smooth Active Iteration Glide Vectors
            if (showTrails && centroids.isNotEmpty()) {
                for (centroid in centroids) {
                    val color = ClusterColors[centroid.clusterId % ClusterColors.size]
                    val liveCentroid = liveCentroidById[centroid.clusterId] ?: centroid
                    val prev = prevCentroidMap[centroid.clusterId]
                    val trail = centroid.trail

                    // Historical convergence trail: draw completed segments up to the previous
                    // iteration, then smoothly extend the active segment to the gliding tip.
                    if (trail.size >= 2) {
                        val isGliding = prev != null && glideT < 0.999f
                        val settledCount = if (isGliding) trail.size - 1 else trail.size
                        val path = Path()
                        for (idx in 0 until settledCount) {
                            val coord = trail[idx]
                            val pos = worldToScreen(coord.x, coord.y, w, h)
                            if (idx == 0) path.moveTo(pos.x, pos.y) else path.lineTo(pos.x, pos.y)
                            val ageAlpha = (0.28f + 0.35f * (idx.toFloat() / trail.size.toFloat())).coerceIn(0.25f, 0.65f)
                            drawCircle(
                                color = color.copy(alpha = ageAlpha),
                                radius = if (idx == 0) 4.8f else 3.8f,
                                center = pos
                            )
                        }
                        if (isGliding) {
                            val livePos = worldToScreen(liveCentroid.x, liveCentroid.y, w, h)
                            path.lineTo(livePos.x, livePos.y)
                        }
                        drawPath(
                            path = path,
                            color = color.copy(alpha = 0.72f),
                            style = Stroke(
                                width = 2.8f,
                                cap = StrokeCap.Round,
                                pathEffect = PathEffect.dashPathEffect(floatArrayOf(10f, 6f), 0f)
                            )
                        )
                    }

                    // Active iteration displacement: fading ghost ring at previous position +
                    // live glide vector & directional arrowhead tracking the moving centroid.
                    if (prev != null) {
                        val dx = centroid.x - prev.x
                        val dy = centroid.y - prev.y
                        val distWorld = sqrt(dx * dx + dy * dy)
                        if (distWorld > 0.002f) {
                            val prevScreen = worldToScreen(prev.x, prev.y, w, h)
                            val liveScreen = worldToScreen(liveCentroid.x, liveCentroid.y, w, h)
                            val fadeFactor = (1f - glideT * 0.45f).coerceIn(0.35f, 1f)

                            // Translucent ghost origin marker showing where this centroid started the iteration
                            drawCircle(
                                color = color.copy(alpha = 0.22f * fadeFactor),
                                radius = 10f,
                                center = prevScreen
                            )
                            drawCircle(
                                color = color.copy(alpha = 0.72f * fadeFactor),
                                radius = 10f,
                                center = prevScreen,
                                style = Stroke(width = 2f)
                            )

                            // Active movement vector from previous position to currently gliding centroid
                            drawLine(
                                color = centroidRingColor.copy(alpha = 0.85f * fadeFactor),
                                start = prevScreen,
                                end = liveScreen,
                                strokeWidth = 3f,
                                cap = StrokeCap.Round
                            )

                            // Directional arrowhead near the moving tip when vector is long enough
                            val vx = liveScreen.x - prevScreen.x
                            val vy = liveScreen.y - prevScreen.y
                            val segLen = sqrt(vx * vx + vy * vy)
                            if (segLen > 18f) {
                                val angle = atan2(vy.toDouble(), vx.toDouble())
                                val headLen = 10f
                                val tip = Offset(
                                    x = liveScreen.x - (vx / segLen) * 14f,
                                    y = liveScreen.y - (vy / segLen) * 14f
                                )
                                val leftWing = Offset(
                                    x = tip.x - (headLen * cos(angle - 0.52)).toFloat(),
                                    y = tip.y - (headLen * sin(angle - 0.52)).toFloat()
                                )
                                val rightWing = Offset(
                                    x = tip.x - (headLen * cos(angle + 0.52)).toFloat(),
                                    y = tip.y - (headLen * sin(angle + 0.52)).toFloat()
                                )
                                drawLine(
                                    color = centroidRingColor.copy(alpha = 0.90f * fadeFactor),
                                    start = tip,
                                    end = leftWing,
                                    strokeWidth = 2.6f,
                                    cap = StrokeCap.Round
                                )
                                drawLine(
                                    color = centroidRingColor.copy(alpha = 0.90f * fadeFactor),
                                    start = tip,
                                    end = rightWing,
                                    strokeWidth = 2.6f,
                                    cap = StrokeCap.Round
                                )
                            }
                        }
                    }
                }
            }

            // 6. Data Points (Core, Border, Standard, or Noise 'X' markers) + Tap Ripple
            for (pt in points) {
                val pos = worldToScreen(pt.x, pt.y, w, h)
                if (pos.x < -20f || pos.x > w + 20f || pos.y < -20f || pos.y > h + 20f) continue

                val isLastTapped = pt.id == lastAddedPointId

                if (pt.role == PointRole.NOISE || (algorithm == AlgorithmType.DBSCAN && pt.clusterId == -1)) {
                    val arm = 6.5f
                    drawLine(
                        color = NoisePointColor,
                        start = Offset(pos.x - arm, pos.y - arm),
                        end = Offset(pos.x + arm, pos.y + arm),
                        strokeWidth = 2.4f,
                        cap = StrokeCap.Round
                    )
                    drawLine(
                        color = NoisePointColor,
                        start = Offset(pos.x + arm, pos.y - arm),
                        end = Offset(pos.x - arm, pos.y + arm),
                        strokeWidth = 2.4f,
                        cap = StrokeCap.Round
                    )
                } else {
                    val color = if (pt.clusterId >= 0) {
                        ClusterColors[pt.clusterId % ClusterColors.size]
                    } else {
                        NoisePointColor
                    }
                    val radius = when (pt.role) {
                        PointRole.CORE -> 8.5f
                        PointRole.BORDER -> 6.2f
                        else -> 7.5f
                    }
                    drawCircle(
                        color = color.copy(alpha = 0.24f),
                        radius = radius + 3.5f,
                        center = pos
                    )
                    drawCircle(
                        color = color,
                        radius = radius,
                        center = pos
                    )
                    if (pt.role == PointRole.BORDER || isLastTapped) {
                        drawCircle(
                            color = centroidRingColor,
                            radius = radius + if (isLastTapped) 2f else 0f,
                            center = pos,
                            style = Stroke(width = if (isLastTapped) 2.4f else 1.6f)
                        )
                    }

                    // Expanding touch ripple around the newly tapped point
                    if (isLastTapped) {
                        val rippleRadius = radius + 8f + 18f * animT
                        val rippleAlpha = (1f - animT * 0.7f).coerceIn(0.15f, 0.9f)
                        drawCircle(
                            color = color.copy(alpha = rippleAlpha),
                            radius = rippleRadius,
                            center = pos,
                            style = Stroke(width = 2.4f)
                        )
                    }
                }
            }

            // 7. Active Cluster Centroid Crosshair Diamonds + Live Coordinate Callout Badges
            for (centroid in liveCentroids) {
                val pos = worldToScreen(centroid.x, centroid.y, w, h)
                val color = ClusterColors[centroid.clusterId % ClusterColors.size]
                val diamondRadius = 14f

                val diamond = Path().apply {
                    moveTo(pos.x, pos.y - diamondRadius)
                    lineTo(pos.x + diamondRadius, pos.y)
                    lineTo(pos.x, pos.y + diamondRadius)
                    lineTo(pos.x - diamondRadius, pos.y)
                    close()
                }
                // Motion halo expands gently while gliding, then settles into a crisp convergence lock ring
                if (!legacyGraphicsMode) {
                    val isMoving = glideT < 0.99f && prevCentroidMap.containsKey(centroid.clusterId)
                    drawCircle(
                        color = color.copy(alpha = if (isMoving) 0.36f else 0.24f),
                        radius = if (isMoving) 23f + (1f - glideT) * 7f else 20f,
                        center = pos
                    )
                    if (algorithm == AlgorithmType.KMEANS && isConverged && glideT >= 0.98f) {
                        drawCircle(
                            color = color.copy(alpha = 0.75f),
                            radius = 22f,
                            center = pos,
                            style = Stroke(width = 1.8f)
                        )
                    }
                }
                drawPath(path = diamond, color = color)
                drawPath(
                    path = diamond,
                    color = centroidRingColor,
                    style = Stroke(width = 2.8f)
                )
                drawCircle(
                    color = centroidRingColor,
                    radius = 3.2f,
                    center = pos
                )

                // Draw crisp on-canvas centroid callout tag: "C1 (0.42, 0.68)"
                drawCentroidLabelBadge(
                    textMeasurer = textMeasurer,
                    label = "C${centroid.clusterId + 1} (${"%.2f".format(centroid.x)}, ${"%.2f".format(centroid.y)})",
                    centroidScreenPos = pos,
                    accentColor = color,
                    isDarkTheme = isDarkTheme,
                    canvasWidth = w,
                    canvasHeight = h
                )
            }

            // 8. User-Authored Cluster Area Text Annotations (long-press callout pins & pills)
            for (annotation in annotations) {
                val anchorPos = worldToScreen(annotation.x, annotation.y, w, h)
                if (anchorPos.x < -24f || anchorPos.x > w + 24f || anchorPos.y < -24f || anchorPos.y > h + 24f) {
                    continue
                }
                val accent = if (annotation.clusterId >= 0) {
                    ClusterColors[annotation.clusterId % ClusterColors.size]
                } else {
                    NoisePointColor
                }
                drawClusterAnnotationBadge(
                    textMeasurer = textMeasurer,
                    annotation = annotation,
                    anchorScreenPos = anchorPos,
                    accentColor = accent,
                    isDarkTheme = isDarkTheme,
                    canvasWidth = w,
                    canvasHeight = h
                )
            }
        }

        // Top-left live HUD column: compact point counter + real-time Silhouette / Inertia quality overlay
        Column(
            modifier = Modifier
                .align(Alignment.TopStart)
                .padding(10.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp)
        ) {
            Surface(
                shape = RoundedCornerShape(12.dp),
                color = MaterialTheme.colorScheme.surface.copy(alpha = 0.88f),
                tonalElevation = 2.dp
            ) {
                Row(
                    modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    Icon(
                        imageVector = Icons.Outlined.TouchApp,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.size(16.dp)
                    )
                    Text(
                        text = if (points.isEmpty()) {
                            stringResource(R.string.empty_canvas_title)
                        } else {
                            "Tap to Add • N=${points.size} • K=${centroids.size}"
                        },
                        style = MaterialTheme.typography.labelMedium,
                        fontWeight = FontWeight.Bold,
                        color = MaterialTheme.colorScheme.onSurface
                    )
                    if (developerModeEnabled) {
                        lastTouchCoord?.let { (lx, ly) ->
                            Text(
                                text = "(${"%.2f".format(lx)}, ${"%.2f".format(ly)})",
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.primary
                            )
                        }
                    }
                    if (zoom != 1f || panOffset != Offset.Zero) {
                        Text(
                            text = "${"%.1f".format(zoom)}x",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.primary
                        )
                    }
                }
            }

            // Real-time Silhouette & Inertia (WCSS) Quality Overlay on Canvas
            if (points.size >= 2) {
                val (qualityLabel, qualityColor) = when {
                    silhouetteScore >= 0.70f -> "Strong" to Color(0xFF10B981)
                    silhouetteScore >= 0.50f -> "Good" to Color(0xFF22C55E)
                    silhouetteScore >= 0.25f -> "Fair" to Color(0xFFF59E0B)
                    silhouetteScore > 0f -> "Weak" to Color(0xFFEF4444)
                    else -> "Low" to Color(0xFF94A3B8)
                }
                val overlayContentDesc = stringResource(R.string.canvas_quality_overlay_desc)

                Surface(
                    shape = RoundedCornerShape(12.dp),
                    color = MaterialTheme.colorScheme.surface.copy(alpha = 0.90f),
                    tonalElevation = 3.dp,
                    border = androidx.compose.foundation.BorderStroke(
                        width = 1.dp,
                        color = qualityColor.copy(alpha = 0.45f)
                    ),
                    modifier = Modifier
                        .semantics { contentDescription = overlayContentDesc }
                        .clickable { qualityOverlayModeIndex = (qualityOverlayModeIndex + 1) % 3 }
                        .testTag("canvas_quality_metrics_overlay")
                ) {
                    Row(
                        modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp)
                    ) {
                        Icon(
                            imageVector = Icons.Outlined.Insights,
                            contentDescription = null,
                            tint = qualityColor,
                            modifier = Modifier.size(15.dp)
                        )
                        if (qualityDisplayMode != CanvasQualityDisplayMode.INERTIA) {
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(4.dp),
                                modifier = Modifier.testTag("canvas_silhouette_value")
                            ) {
                                Box(
                                    modifier = Modifier
                                        .size(7.dp)
                                        .clip(CircleShape)
                                        .background(qualityColor)
                                )
                                Text(
                                    text = String.format(
                                        Locale.US,
                                        "Silhouette %.2f (%s)",
                                        silhouetteScore,
                                        qualityLabel
                                    ),
                                    style = MaterialTheme.typography.labelSmall,
                                    fontWeight = FontWeight.Bold,
                                    color = MaterialTheme.colorScheme.onSurface
                                )
                            }
                        }
                        if (qualityDisplayMode == CanvasQualityDisplayMode.BOTH) {
                            Text(
                                text = "•",
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                        if (qualityDisplayMode != CanvasQualityDisplayMode.SILHOUETTE) {
                            Text(
                                text = if (algorithm == AlgorithmType.KMEANS) {
                                    String.format(Locale.US, "Inertia %.3f", inertiaWcss)
                                } else {
                                    String.format(Locale.US, "Inertia %.3f • Noise %d", inertiaWcss, noiseCount)
                                },
                                style = MaterialTheme.typography.labelSmall,
                                fontWeight = FontWeight.SemiBold,
                                color = MaterialTheme.colorScheme.primary,
                                modifier = Modifier.testTag("canvas_inertia_value")
                            )
                        }
                    }
                }
            }

            // Live K-Means Iteration & Convergence Motion Indicator Pill
            if (algorithm == AlgorithmType.KMEANS && totalIterations > 1 && points.isNotEmpty()) {
                val iterNum = (currentIteration + 1).coerceIn(1, totalIterations)
                val progressFraction = if (totalIterations > 1) {
                    (currentIteration.toFloat() / (totalIterations - 1).toFloat()).coerceIn(0f, 1f)
                } else {
                    1f
                }
                val accentColor = if (isConverged) Color(0xFF10B981) else MaterialTheme.colorScheme.primary
                Surface(
                    shape = RoundedCornerShape(12.dp),
                    color = MaterialTheme.colorScheme.surface.copy(alpha = 0.90f),
                    tonalElevation = 2.dp,
                    border = androidx.compose.foundation.BorderStroke(
                        width = 1.dp,
                        color = accentColor.copy(alpha = 0.40f)
                    ),
                    modifier = Modifier.testTag("kmeans_convergence_pill")
                ) {
                    Row(
                        modifier = Modifier.padding(horizontal = 10.dp, vertical = 5.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(7.dp)
                    ) {
                        Icon(
                            imageVector = if (isConverged) Icons.Outlined.CheckCircle else Icons.AutoMirrored.Outlined.TrendingFlat,
                            contentDescription = null,
                            tint = accentColor,
                            modifier = Modifier.size(14.dp)
                        )
                        Text(
                            text = if (isConverged) {
                                "Converged • Iter $iterNum/$totalIterations"
                            } else if (totalIterationShift > 0.0005f) {
                                String.format(
                                    Locale.US,
                                    "Iter %d/%d • Shift Δ %.3f",
                                    iterNum,
                                    totalIterations,
                                    totalIterationShift
                                )
                            } else {
                                "Iter $iterNum/$totalIterations"
                            },
                            style = MaterialTheme.typography.labelSmall,
                            fontWeight = FontWeight.SemiBold,
                            color = MaterialTheme.colorScheme.onSurface
                        )
                        // Mini convergence progress bar
                        Box(
                            modifier = Modifier
                                .width(34.dp)
                                .height(5.dp)
                                .clip(CircleShape)
                                .background(MaterialTheme.colorScheme.outline.copy(alpha = 0.28f))
                        ) {
                            Box(
                                modifier = Modifier
                                    .fillMaxWidth(progressFraction.coerceAtLeast(0.12f))
                                    .height(5.dp)
                                    .clip(CircleShape)
                                    .background(accentColor)
                            )
                        }
                    }
                }
            }
        }

        // Top-right Canvas View utility buttons (Reset Zoom always if zoomed; Grid/Spider toggles only in Developer Mode)
        Row(
            modifier = Modifier
                .align(Alignment.TopEnd)
                .padding(8.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp)
        ) {
            if (zoom != 1f || panOffset != Offset.Zero) {
                FilledTonalIconButton(
                    onClick = {
                        zoom = 1f
                        panOffset = Offset.Zero
                    },
                    modifier = Modifier
                        .size(48.dp)
                        .testTag("reset_zoom_button")
                ) {
                    Icon(
                        imageVector = Icons.Outlined.CenterFocusStrong,
                        contentDescription = "Reset Pan and Zoom"
                    )
                }
            }
            if (developerModeEnabled) {
                FilledTonalIconButton(
                    onClick = onToggleSpiderLines,
                    modifier = Modifier
                        .size(48.dp)
                        .testTag("toggle_spider_lines_button")
                ) {
                    Icon(
                        imageVector = Icons.Outlined.Hub,
                        contentDescription = "Toggle Point-to-Centroid Assignment Lines",
                        tint = if (showSpiderLines) {
                            MaterialTheme.colorScheme.primary
                        } else {
                            MaterialTheme.colorScheme.onSurfaceVariant
                        }
                    )
                }
                FilledTonalIconButton(
                    onClick = onToggleGrid,
                    modifier = Modifier
                        .size(48.dp)
                        .testTag("toggle_grid_button")
                ) {
                    Icon(
                        imageVector = Icons.Outlined.GridOn,
                        contentDescription = "Toggle Coordinate Grid",
                        tint = if (showGrid) {
                            MaterialTheme.colorScheme.primary
                        } else {
                            MaterialTheme.colorScheme.onSurfaceVariant
                        }
                    )
                }
            }
        }

        // Bottom Live Centroid Ticker Bar (shown in Developer Mode, or empty hint when empty)
        if (centroids.isNotEmpty() && developerModeEnabled) {
            val prevById = previousCentroids.associateBy { it.clusterId }
            Surface(
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .fillMaxWidth()
                    .padding(horizontal = 10.dp, vertical = 8.dp)
                    .testTag("live_centroid_hud_bar"),
                shape = RoundedCornerShape(12.dp),
                color = MaterialTheme.colorScheme.surface.copy(alpha = 0.90f),
                tonalElevation = 3.dp
            ) {
                Row(
                    modifier = Modifier
                        .horizontalScroll(rememberScrollState())
                        .padding(horizontal = 10.dp, vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(10.dp)
                ) {
                    Text(
                        text = "LIVE CENTROIDS:",
                        style = MaterialTheme.typography.labelSmall,
                        fontWeight = FontWeight.Bold,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    centroids.forEach { c ->
                        val cColor = ClusterColors[c.clusterId % ClusterColors.size]
                        val prev = prevById[c.clusterId]
                        val delta = if (prev != null) {
                            val dx = c.x - prev.x
                            val dy = c.y - prev.y
                            sqrt(dx * dx + dy * dy)
                        } else 0f

                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Box(
                                modifier = Modifier
                                    .size(9.dp)
                                    .clip(CircleShape)
                                    .background(cColor)
                            )
                            Spacer(modifier = Modifier.width(4.dp))
                            Text(
                                text = buildString {
                                    append("C${c.clusterId + 1}(${"%.2f".format(c.x)}, ${"%.2f".format(c.y)})")
                                    if (delta > 0.001f) {
                                        append(" Δ${"%.3f".format(delta)}")
                                    }
                                },
                                style = MaterialTheme.typography.labelSmall,
                                fontWeight = FontWeight.SemiBold,
                                color = MaterialTheme.colorScheme.onSurface
                            )
                        }
                    }
                }
            }
        } else if (points.isEmpty()) {
            // Subtle bottom hint when canvas is empty (does NOT block taps in the middle of the canvas)
            Surface(
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .padding(12.dp),
                shape = RoundedCornerShape(14.dp),
                color = MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.92f)
            ) {
                Text(
                    text = stringResource(R.string.empty_canvas_tip),
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onPrimaryContainer,
                    modifier = Modifier.padding(horizontal = 14.dp, vertical = 8.dp)
                )
            }
        } else {
            // Subtle bottom-end annotation status / long-press discoverability badge
            Surface(
                modifier = Modifier
                    .align(Alignment.BottomEnd)
                    .padding(10.dp)
                    .testTag("canvas_annotation_hint_badge"),
                shape = RoundedCornerShape(12.dp),
                color = MaterialTheme.colorScheme.surface.copy(alpha = 0.88f),
                tonalElevation = 2.dp
            ) {
                Row(
                    modifier = Modifier.padding(horizontal = 10.dp, vertical = 5.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp)
                ) {
                    Icon(
                        imageVector = Icons.Outlined.StickyNote2,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.size(14.dp)
                    )
                    Text(
                        text = if (annotations.isEmpty()) {
                            stringResource(R.string.canvas_long_press_hint)
                        } else {
                            "${annotations.size} note${if (annotations.size == 1) "" else "s"} • PDF ready"
                        },
                        style = MaterialTheme.typography.labelSmall,
                        fontWeight = FontWeight.Medium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
        }
    }
}

private fun DrawScope.drawCentroidLabelBadge(
    textMeasurer: TextMeasurer,
    label: String,
    centroidScreenPos: Offset,
    accentColor: Color,
    isDarkTheme: Boolean,
    canvasWidth: Float,
    canvasHeight: Float
) {
    val textLayout = textMeasurer.measure(
        text = label,
        style = TextStyle(
            color = if (isDarkTheme) Color.White else Color(0xFF0F172A),
            fontSize = 10.sp,
            fontWeight = FontWeight.Bold
        )
    )
    val padX = 12f
    val padY = 6f
    val pillW = textLayout.size.width + padX * 2
    val pillH = textLayout.size.height + padY * 2

    val rawX = centroidScreenPos.x + 16f
    val rawY = centroidScreenPos.y - pillH - 6f
    val clampedX = rawX.coerceIn(6f, (canvasWidth - pillW - 6f).coerceAtLeast(6f))
    val clampedY = rawY.coerceIn(6f, (canvasHeight - pillH - 6f).coerceAtLeast(6f))

    drawRoundRect(
        color = if (isDarkTheme) Color(0xDD0F172A) else Color(0xEEFFFFFF),
        topLeft = Offset(clampedX, clampedY),
        size = Size(pillW, pillH),
        cornerRadius = CornerRadius(10f, 10f)
    )
    drawRoundRect(
        color = accentColor,
        topLeft = Offset(clampedX, clampedY),
        size = Size(pillW, pillH),
        cornerRadius = CornerRadius(10f, 10f),
        style = Stroke(width = 2f)
    )
    drawText(
        textLayoutResult = textLayout,
        topLeft = Offset(clampedX + padX, clampedY + padY)
    )
}

private fun DrawScope.drawClusterAnnotationBadge(
    textMeasurer: TextMeasurer,
    annotation: ClusterAnnotation,
    anchorScreenPos: Offset,
    accentColor: Color,
    isDarkTheme: Boolean,
    canvasWidth: Float,
    canvasHeight: Float
) {
    val prefix = if (annotation.clusterId >= 0) "C${annotation.clusterId + 1}: " else "Note: "
    val truncated = if (annotation.text.length > 26) annotation.text.take(25) + "…" else annotation.text
    val fullText = "$prefix$truncated"

    val textLayout = textMeasurer.measure(
        text = fullText,
        style = TextStyle(
            color = if (isDarkTheme) Color(0xFFF8FAFC) else Color(0xFF0F172A),
            fontSize = 10.5.sp,
            fontWeight = FontWeight.SemiBold
        )
    )
    val padX = 14f
    val padY = 7f
    val pillW = textLayout.size.width + padX * 2
    val pillH = textLayout.size.height + padY * 2

    val rawX = anchorScreenPos.x - pillW * 0.5f
    val rawY = anchorScreenPos.y - pillH - 16f
    val clampedX = rawX.coerceIn(8f, (canvasWidth - pillW - 8f).coerceAtLeast(8f))
    val clampedY = rawY.coerceIn(8f, (canvasHeight - pillH - 8f).coerceAtLeast(8f))

    val stemTargetX = (clampedX + pillW * 0.5f).coerceIn(clampedX + 10f, clampedX + pillW - 10f)
    val stemTargetY = if (clampedY + pillH < anchorScreenPos.y) clampedY + pillH else clampedY

    drawLine(
        color = accentColor.copy(alpha = 0.90f),
        start = anchorScreenPos,
        end = Offset(stemTargetX, stemTargetY),
        strokeWidth = 2.2f,
        cap = StrokeCap.Round
    )
    drawCircle(
        color = accentColor,
        radius = 6f,
        center = anchorScreenPos
    )
    drawCircle(
        color = if (isDarkTheme) Color.White else Color(0xFF0F172A),
        radius = 6f,
        center = anchorScreenPos,
        style = Stroke(width = 1.8f)
    )

    drawRoundRect(
        color = if (isDarkTheme) Color(0xEE1E293B) else Color(0xF5FFFFFF),
        topLeft = Offset(clampedX, clampedY),
        size = Size(pillW, pillH),
        cornerRadius = CornerRadius(12f, 12f)
    )
    drawRoundRect(
        color = accentColor,
        topLeft = Offset(clampedX, clampedY),
        size = Size(pillW, pillH),
        cornerRadius = CornerRadius(12f, 12f),
        style = Stroke(width = 2.2f)
    )
    drawText(
        textLayoutResult = textLayout,
        topLeft = Offset(clampedX + padX, clampedY + padY)
    )
}

private fun DrawScope.drawVoronoiRegions(
    centroids: List<CentroidState>,
    width: Float,
    height: Float,
    zoom: Float,
    panOffset: Offset,
    isDarkTheme: Boolean,
    legacyGraphicsMode: Boolean = false
) {
    val cols = if (legacyGraphicsMode) 18 else 34
    val rows = if (legacyGraphicsMode) 12 else 28
    val cellW = width / cols
    val cellH = height / rows
    val fillAlpha = if (isDarkTheme) 0.11f else 0.13f

    for (r in 0 until rows) {
        val sy = (r + 0.5f) * cellH
        val wy = (sy - panOffset.y) / (height * zoom)
        for (c in 0 until cols) {
            val sx = (c + 0.5f) * cellW
            val wx = (sx - panOffset.x) / (width * zoom)

            var nearestCluster = centroids.first().clusterId
            var minDistSq = Float.MAX_VALUE
            for (centroid in centroids) {
                val dx = wx - centroid.x
                val dy = wy - centroid.y
                val d2 = dx * dx + dy * dy
                if (d2 < minDistSq) {
                    minDistSq = d2
                    nearestCluster = centroid.clusterId
                }
            }
            val color = ClusterColors[nearestCluster % ClusterColors.size].copy(alpha = fillAlpha)
            drawRect(
                color = color,
                topLeft = Offset(c * cellW, r * cellH),
                size = Size(cellW + 0.6f, cellH + 0.6f)
            )
        }
    }
}
