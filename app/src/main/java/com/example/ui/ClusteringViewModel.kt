package com.example.ui

import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.example.data.BatchPdfReportGenerator
import com.example.data.BatchPdfReportInput
import com.example.data.DatasetRepository
import com.example.data.LocalPdfReportInfo
import com.example.data.SavedDatasetEntity
import com.example.data.ThemePreferencesRepository
import com.example.domain.ClusteringEngine
import com.example.domain.DatasetGenerator
import com.example.model.AlgorithmType
import com.example.model.BatchJobStatus
import com.example.model.BatchProcessingState
import com.example.model.BatchQueueItem
import com.example.model.CanvasToolMode
import com.example.model.CentroidState
import com.example.model.ClusterAnnotation
import com.example.model.ClusteringSessionRun
import com.example.model.ClusteringStepFrame
import com.example.model.DataPoint
import com.example.model.DbscanConfig
import com.example.model.KMeansConfig
import com.example.model.PresetDatasetType
import com.example.service.RpcService
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.withContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlin.math.sqrt
import kotlin.random.Random

data class ClusteringUiState(
    val datasetTitle: String = PresetDatasetType.TWO_MOONS.title,
    val selectedPreset: PresetDatasetType = PresetDatasetType.TWO_MOONS,
    val sampleCount: Int = 160,
    val noiseSpread: Float = 0.035f,
    val algorithm: AlgorithmType = AlgorithmType.KMEANS,
    val kMeansConfig: KMeansConfig = KMeansConfig(),
    val dbscanConfig: DbscanConfig = DbscanConfig(),
    val toolMode: CanvasToolMode = CanvasToolMode.ADD,
    val rawPoints: List<DataPoint> = emptyList(),
    val frames: List<ClusteringStepFrame> = emptyList(),
    val currentFrameIndex: Int = 0,
    val previousCentroids: List<CentroidState> = emptyList(),
    val centroidTransitionNonce: Int = 0,
    val lastAddedPointId: Int? = null,
    val showSpiderLines: Boolean = true,
    val isPlaying: Boolean = false,
    val isDarkTheme: Boolean = true,
    val showGrid: Boolean = true,
    val developerModeEnabled: Boolean = false,
    val showCoachMarkTour: Boolean = false,
    val sessionHistory: List<ClusteringSessionRun> = emptyList(),
    val activeHistoryRunId: Int? = null,
    val batchState: BatchProcessingState = BatchProcessingState(),
    val annotations: List<ClusterAnnotation> = emptyList(),
    val statusBanner: String? = null
) {
    val activeFrame: ClusteringStepFrame?
        get() = frames.getOrNull(currentFrameIndex) ?: frames.lastOrNull()

    val totalFrames: Int
        get() = frames.size.coerceAtLeast(1)
}

class ClusteringViewModel(
    private val repository: DatasetRepository? = null,
    private val themePreferences: ThemePreferencesRepository? = null
) : ViewModel() {

    private val _uiState = MutableStateFlow(ClusteringUiState())
    val uiState: StateFlow<ClusteringUiState> = _uiState.asStateFlow()

    val savedDatasets: StateFlow<List<SavedDatasetEntity>> =
        repository?.savedDatasets?.stateIn(
            scope = viewModelScope,
            started = SharingStarted.WhileSubscribed(5000),
            initialValue = emptyList()
        ) ?: MutableStateFlow(emptyList())

    private var playbackJob: Job? = null
    private var computeJob: Job? = null
    private var batchJob: Job? = null
    private var nextPointId: Int = 1000
    private var nextHistoryRunId: Int = 1
    private var nextBatchJobId: Int = 1
    private var nextAnnotationId: Int = 1
    private var randomSeed: Long = 42L
    private var onboardingInitialized: Boolean = false

    companion object {
        const val MAX_SESSION_HISTORY = 10
    }

    init {
        loadPreset(PresetDatasetType.TWO_MOONS, jumpToConverged = true)
        if (themePreferences != null) {
            viewModelScope.launch {
                themePreferences.preferencesFlow.collect { prefs ->
                    RpcService.setDeveloperMode(prefs.developerModeEnabled)
                    val shouldLaunchTour = !onboardingInitialized && !prefs.hasCompletedOnboarding
                    onboardingInitialized = true
                    _uiState.update { state ->
                        state.copy(
                            isDarkTheme = prefs.isDarkTheme,
                            showGrid = prefs.showGrid,
                            showSpiderLines = prefs.showSpiderLines,
                            developerModeEnabled = prefs.developerModeEnabled,
                            showCoachMarkTour = if (shouldLaunchTour) true else state.showCoachMarkTour
                        )
                    }
                }
            }
        }
    }

    fun completeCoachMarkTour() {
        _uiState.update { it.copy(showCoachMarkTour = false) }
        themePreferences?.let { repo ->
            viewModelScope.launch {
                repo.setHasCompletedOnboarding(true)
            }
        }
    }

    fun replayCoachMarkTour() {
        _uiState.update { it.copy(showCoachMarkTour = true) }
    }

    fun runClusteringAnimationFromStart() {
        pausePlayback()
        randomSeed = System.currentTimeMillis() + nextHistoryRunId
        _uiState.update {
            it.copy(
                previousCentroids = emptyList(),
                centroidTransitionNonce = it.centroidTransitionNonce + 1
            )
        }
        recomputeFrames(jumpToEnd = false)
        startPlayback()
    }

    /**
     * Jumps back to a previously recorded clustering run from Session History without
     * overwriting or duplicating history entries, allowing seamless A/B inertia comparison.
     */
    fun restoreSessionRun(runId: Int) {
        val run = _uiState.value.sessionHistory.firstOrNull { it.runId == runId } ?: return
        pausePlayback()
        computeJob?.cancel()
        randomSeed = run.randomSeed
        nextPointId = (run.rawPoints.maxOfOrNull { it.id } ?: nextPointId) + 1
        val targetFrameIdx = (run.frames.size - 1).coerceAtLeast(0)
        _uiState.update { current ->
            current.copy(
                datasetTitle = run.datasetTitle,
                algorithm = run.algorithm,
                kMeansConfig = run.kMeansConfig,
                dbscanConfig = run.dbscanConfig,
                rawPoints = run.rawPoints,
                frames = run.frames,
                currentFrameIndex = targetFrameIdx,
                previousCentroids = emptyList(),
                lastAddedPointId = null,
                activeHistoryRunId = run.runId,
                annotations = run.annotations,
                statusBanner = "Restored Run #${run.runId} (${run.parameterSummary} • Inertia ${"%.3f".format(run.inertiaWcss)})."
            )
        }
    }

    fun clearSessionHistory() {
        _uiState.update { current ->
            current.copy(
                sessionHistory = emptyList(),
                activeHistoryRunId = null,
                statusBanner = "Session history cleared."
            )
        }
    }

    // =========================================================================
    // Cluster Area Text Annotations (Canvas Callouts + Exported PDF Reports)
    // =========================================================================

    fun addOrUpdateClusterAnnotation(
        clusterId: Int,
        x: Float,
        y: Float,
        text: String,
        existingId: Int? = null
    ): ClusterAnnotation? {
        val cleaned = text.trim().take(120)
        if (cleaned.isEmpty()) return null
        val clampedX = x.coerceIn(0.02f, 0.98f)
        val clampedY = y.coerceIn(0.02f, 0.98f)
        var savedAnnotation: ClusterAnnotation? = null

        _uiState.update { current ->
            val updatedList = if (existingId != null && current.annotations.any { it.id == existingId }) {
                current.annotations.map { ann ->
                    if (ann.id == existingId) {
                        ann.copy(clusterId = clusterId, x = clampedX, y = clampedY, text = cleaned)
                            .also { savedAnnotation = it }
                    } else {
                        ann
                    }
                }
            } else {
                val created = ClusterAnnotation(
                    id = nextAnnotationId++,
                    clusterId = clusterId,
                    x = clampedX,
                    y = clampedY,
                    text = cleaned
                )
                savedAnnotation = created
                current.annotations + created
            }

            val updatedHistory = syncAnnotationsToActiveHistory(current, updatedList)
            val areaLabel = if (clusterId >= 0) "Cluster ${clusterId + 1}" else "Canvas Area"
            current.copy(
                annotations = updatedList,
                sessionHistory = updatedHistory,
                statusBanner = "Saved note on $areaLabel — will appear in exported PDF reports."
            )
        }
        return savedAnnotation
    }

    fun deleteClusterAnnotation(annotationId: Int) {
        _uiState.update { current ->
            val updatedList = current.annotations.filterNot { it.id == annotationId }
            if (updatedList.size == current.annotations.size) return@update current
            val updatedHistory = syncAnnotationsToActiveHistory(current, updatedList)
            current.copy(
                annotations = updatedList,
                sessionHistory = updatedHistory,
                statusBanner = "Removed cluster annotation."
            )
        }
    }

    fun clearAnnotations() {
        _uiState.update { current ->
            if (current.annotations.isEmpty()) return@update current
            val updatedHistory = syncAnnotationsToActiveHistory(current, emptyList())
            current.copy(
                annotations = emptyList(),
                sessionHistory = updatedHistory,
                statusBanner = "Cleared all cluster annotations."
            )
        }
    }

    private fun syncAnnotationsToActiveHistory(
        state: ClusteringUiState,
        updatedAnnotations: List<ClusterAnnotation>
    ): List<ClusteringSessionRun> {
        val activeId = state.activeHistoryRunId ?: return state.sessionHistory
        return state.sessionHistory.map { run ->
            if (run.runId == activeId) run.copy(annotations = updatedAnnotations) else run
        }
    }

    // =========================================================================
    // Sequential Batch Processing & Automatic Combined PDF Report Generation
    // =========================================================================

    fun enqueueCurrentCanvasForBatch() {
        val state = _uiState.value
        if (state.rawPoints.isEmpty()) {
            postStatusBanner("Add points to the canvas before adding it to the batch queue.")
            return
        }
        enqueuePointsForBatch(
            title = state.datasetTitle,
            sourceLabel = "Canvas",
            points = state.rawPoints,
            algorithm = state.algorithm,
            kMeansConfig = state.kMeansConfig,
            dbscanConfig = state.dbscanConfig,
            annotations = state.annotations
        )
    }

    fun enqueuePresetForBatch(
        preset: PresetDatasetType,
        algorithmOverride: AlgorithmType? = null,
        kOverride: Int? = null,
        epsilonOverride: Float? = null
    ) {
        val state = _uiState.value
        val algo = algorithmOverride ?: state.algorithm
        val generatedPoints = DatasetGenerator.generate(
            type = preset,
            count = state.sampleCount,
            noiseSpread = state.noiseSpread,
            seed = 100L + nextBatchJobId * 31L
        )
        val kmCfg = kOverride?.let { state.kMeansConfig.copy(k = it.coerceIn(2, 10)) } ?: state.kMeansConfig
        val dbCfg = epsilonOverride?.let { state.dbscanConfig.copy(epsilon = it.coerceIn(0.02f, 0.25f)) }
            ?: state.dbscanConfig
        enqueuePointsForBatch(
            title = preset.title,
            sourceLabel = "Preset",
            points = generatedPoints,
            algorithm = algo,
            kMeansConfig = kmCfg,
            dbscanConfig = dbCfg
        )
    }

    fun enqueueSavedSnapshotForBatch(entity: SavedDatasetEntity) {
        val points = repository?.deserializePoints(entity.pointsSerialized).orEmpty()
        if (points.isEmpty()) {
            postStatusBanner("Saved snapshot '${entity.title}' has no points to queue.")
            return
        }
        val algo = runCatching { AlgorithmType.valueOf(entity.algorithm) }
            .getOrDefault(AlgorithmType.KMEANS)
        val state = _uiState.value
        enqueuePointsForBatch(
            title = entity.title,
            sourceLabel = "Snapshot",
            points = points,
            algorithm = algo,
            kMeansConfig = state.kMeansConfig.copy(k = entity.kValue.coerceIn(2, 10)),
            dbscanConfig = state.dbscanConfig.copy(
                epsilon = entity.epsilonValue.coerceIn(0.02f, 0.25f),
                minPts = entity.minPtsValue.coerceIn(2, 20)
            )
        )
    }

    fun enqueueStandardBenchmarkSuite() {
        enqueuePresetForBatch(
            preset = PresetDatasetType.TWO_MOONS,
            algorithmOverride = AlgorithmType.DBSCAN,
            epsilonOverride = 0.09f
        )
        enqueuePresetForBatch(
            preset = PresetDatasetType.GAUSSIAN_BLOBS,
            algorithmOverride = AlgorithmType.KMEANS,
            kOverride = 4
        )
        enqueuePresetForBatch(
            preset = PresetDatasetType.CONCENTRIC_RINGS,
            algorithmOverride = AlgorithmType.DBSCAN,
            epsilonOverride = 0.085f
        )
        postStatusBanner("Added 3-dataset benchmark suite to the batch queue.")
    }

    fun enqueuePointsForBatch(
        title: String,
        sourceLabel: String,
        points: List<DataPoint>,
        algorithm: AlgorithmType,
        kMeansConfig: KMeansConfig,
        dbscanConfig: DbscanConfig,
        annotations: List<ClusterAnnotation> = emptyList()
    ) {
        if (points.isEmpty()) return
        val item = BatchQueueItem(
            jobId = nextBatchJobId++,
            datasetTitle = title.ifBlank { "Dataset #${nextBatchJobId}" },
            sourceLabel = sourceLabel,
            algorithm = algorithm,
            kMeansConfig = kMeansConfig,
            dbscanConfig = dbscanConfig,
            rawPoints = points,
            annotations = annotations
        )
        _uiState.update { current ->
            val updatedQueue = current.batchState.queue + item
            current.copy(
                batchState = current.batchState.copy(queue = updatedQueue),
                statusBanner = "Queued '${item.datasetTitle}' (${item.parameterSummary}) • ${updatedQueue.size} in batch."
            )
        }
    }

    fun removeBatchQueueItem(jobId: Int) {
        _uiState.update { current ->
            if (current.batchState.isRunning) return@update current
            current.copy(
                batchState = current.batchState.copy(
                    queue = current.batchState.queue.filterNot { it.jobId == jobId }
                )
            )
        }
    }

    fun clearBatchQueue() {
        _uiState.update { current ->
            if (current.batchState.isRunning) return@update current
            current.copy(
                batchState = BatchProcessingState(),
                statusBanner = "Batch queue cleared."
            )
        }
    }

    fun loadBatchResultToCanvas(jobId: Int) {
        val item = _uiState.value.batchState.queue.firstOrNull { it.jobId == jobId } ?: return
        val frame = item.resultFrame ?: return
        pausePlayback()
        computeJob?.cancel()
        nextPointId = (item.rawPoints.maxOfOrNull { it.id } ?: nextPointId) + 1
        _uiState.update { current ->
            current.copy(
                datasetTitle = item.datasetTitle,
                algorithm = item.algorithm,
                kMeansConfig = item.kMeansConfig,
                dbscanConfig = item.dbscanConfig,
                rawPoints = item.rawPoints,
                frames = listOf(frame),
                currentFrameIndex = 0,
                previousCentroids = emptyList(),
                lastAddedPointId = null,
                annotations = item.annotations,
                statusBanner = "Loaded batch result '${item.datasetTitle}' (${item.parameterSummary}) onto canvas."
            )
        }
    }

    fun buildBatchPdfReportInput(batchTitle: String): BatchPdfReportInput {
        val state = _uiState.value
        return BatchPdfReportInput(
            batchTitle = batchTitle.ifBlank { "ClusterLab_Batch_Summary" },
            completedItems = state.batchState.queue.filter { it.status == BatchJobStatus.COMPLETED },
            showVoronoi = state.kMeansConfig.showVoronoi,
            showTrails = state.kMeansConfig.showTrails,
            showSpiderLines = state.showSpiderLines,
            showEpsilonRings = state.dbscanConfig.showEpsilonRings
        )
    }

    fun launchBatchProcessing(
        context: Context,
        batchName: String = "ClusterLab_Batch_Summary",
        onCombinedPdfSaved: (LocalPdfReportInfo) -> Unit = {}
    ) {
        if (_uiState.value.batchState.isRunning || _uiState.value.batchState.queue.isEmpty()) return
        batchJob?.cancel()
        batchJob = viewModelScope.launch {
            val savedPdf = executeBatchQueueAndGeneratePdf(context, batchName)
            if (savedPdf != null) {
                onCombinedPdfSaved(savedPdf)
            }
        }
    }

    /**
     * Executes every queued dataset sequentially, records converged metrics for each run,
     * and automatically generates & saves a combined multi-page PDF summary report.
     */
    suspend fun executeBatchQueueAndGeneratePdf(
        context: Context,
        batchName: String = "ClusterLab_Batch_Summary"
    ): LocalPdfReportInfo? {
        val initialQueue = _uiState.value.batchState.queue
        if (initialQueue.isEmpty()) return null

        val resetQueue = initialQueue.map {
            it.copy(status = BatchJobStatus.QUEUED, resultFrame = null, durationMs = 0L, errorMessage = null)
        }
        _uiState.update { current ->
            current.copy(
                batchState = current.batchState.copy(
                    queue = resetQueue,
                    isRunning = true,
                    currentJobIndex = 0
                )
            )
        }

        val workingQueue = resetQueue.toMutableList()
        for (idx in workingQueue.indices) {
            val item = workingQueue[idx]
            workingQueue[idx] = item.copy(status = BatchJobStatus.RUNNING)
            _uiState.update { current ->
                current.copy(
                    batchState = current.batchState.copy(
                        queue = workingQueue.toList(),
                        isRunning = true,
                        currentJobIndex = idx
                    )
                )
            }

            val startNs = System.nanoTime()
            val computedResult = runCatching {
                withContext(Dispatchers.Default) {
                    val frames = when (item.algorithm) {
                        AlgorithmType.KMEANS -> ClusteringEngine.computeKMeansFrames(
                            rawPoints = item.rawPoints,
                            config = item.kMeansConfig,
                            seed = 42L + item.jobId * 17L
                        )
                        AlgorithmType.DBSCAN -> ClusteringEngine.computeDbscanFrames(
                            rawPoints = item.rawPoints,
                            config = item.dbscanConfig
                        )
                    }
                    frames.lastOrNull()
                        ?: throw IllegalStateException("No clustering frames computed for '${item.datasetTitle}'.")
                }
            }
            val elapsedMs = ((System.nanoTime() - startNs) / 1_000_000L).coerceAtLeast(1L)

            workingQueue[idx] = computedResult.fold(
                onSuccess = { finalFrame ->
                    item.copy(
                        status = BatchJobStatus.COMPLETED,
                        resultFrame = finalFrame,
                        durationMs = elapsedMs,
                        errorMessage = null
                    )
                },
                onFailure = { err ->
                    item.copy(
                        status = BatchJobStatus.FAILED,
                        durationMs = elapsedMs,
                        errorMessage = err.message ?: "Clustering failed"
                    )
                }
            )

            _uiState.update { current ->
                current.copy(
                    batchState = current.batchState.copy(
                        queue = workingQueue.toList(),
                        isRunning = true,
                        currentJobIndex = idx
                    )
                )
            }
        }

        val completedRuns = workingQueue.filter { it.status == BatchJobStatus.COMPLETED && it.resultFrame != null }
        val cleanBatchName = batchName.trim().ifBlank { "ClusterLab_Batch_Summary" }
        val savedPdfInfo = if (completedRuns.isNotEmpty()) {
            withContext(Dispatchers.IO) {
                val state = _uiState.value
                BatchPdfReportGenerator.saveCombinedBatchPdfToLocalDevice(
                    context = context,
                    input = BatchPdfReportInput(
                        batchTitle = cleanBatchName,
                        completedItems = completedRuns,
                        showVoronoi = state.kMeansConfig.showVoronoi,
                        showTrails = state.kMeansConfig.showTrails,
                        showSpiderLines = state.showSpiderLines,
                        showEpsilonRings = state.dbscanConfig.showEpsilonRings
                    ),
                    desiredName = cleanBatchName
                )
            }
        } else {
            null
        }

        val completedLabel = SimpleDateFormat("HH:mm:ss", Locale.US).format(Date())
        _uiState.update { current ->
            current.copy(
                batchState = current.batchState.copy(
                    queue = workingQueue.toList(),
                    isRunning = false,
                    currentJobIndex = -1,
                    lastCombinedPdfFileName = savedPdfInfo?.fileName,
                    lastCombinedPdfSizeLabel = savedPdfInfo?.formattedSize,
                    lastCompletedAtLabel = completedLabel
                ),
                statusBanner = if (savedPdfInfo != null) {
                    "Batch finished (${completedRuns.size}/${workingQueue.size} runs) — saved combined PDF '${savedPdfInfo.fileName}' (${savedPdfInfo.formattedSize})."
                } else {
                    "Batch finished with no completed runs to export."
                }
            )
        }
        return savedPdfInfo
    }

    fun selectAlgorithm(algorithm: AlgorithmType) {
        pausePlayback()
        _uiState.update { it.copy(algorithm = algorithm) }
        recomputeFrames(jumpToEnd = true)
    }

    fun selectToolMode(mode: CanvasToolMode) {
        _uiState.update { it.copy(toolMode = mode) }
    }

    fun setDarkTheme(enabled: Boolean) {
        _uiState.update { it.copy(isDarkTheme = enabled) }
        themePreferences?.let { repo ->
            viewModelScope.launch {
                repo.setDarkTheme(enabled)
            }
        }
    }

    fun toggleTheme() {
        setDarkTheme(!_uiState.value.isDarkTheme)
    }

    fun setDeveloperMode(enabled: Boolean) {
        RpcService.setDeveloperMode(enabled)
        _uiState.update { it.copy(developerModeEnabled = enabled) }
        themePreferences?.let { repo ->
            viewModelScope.launch {
                repo.setDeveloperMode(enabled)
            }
        }
    }

    fun setShowGrid(show: Boolean) {
        _uiState.update { it.copy(showGrid = show) }
        themePreferences?.let { repo ->
            viewModelScope.launch {
                repo.setShowGrid(show)
            }
        }
    }

    fun toggleGrid() {
        setShowGrid(!_uiState.value.showGrid)
    }

    fun setShowSpiderLines(show: Boolean) {
        _uiState.update { it.copy(showSpiderLines = show) }
        themePreferences?.let { repo ->
            viewModelScope.launch {
                repo.setShowSpiderLines(show)
            }
        }
    }

    fun toggleSpiderLines() {
        setShowSpiderLines(!_uiState.value.showSpiderLines)
    }

    fun updateKMeansK(k: Int) {
        val clamped = k.coerceIn(2, 10)
        pausePlayback()
        _uiState.update {
            it.copy(kMeansConfig = it.kMeansConfig.copy(k = clamped))
        }
        recomputeFrames(jumpToEnd = true)
    }

    fun toggleKMeansPlusPlus(enabled: Boolean) {
        pausePlayback()
        _uiState.update {
            it.copy(kMeansConfig = it.kMeansConfig.copy(useKMeansPlusPlus = enabled))
        }
        recomputeFrames(jumpToEnd = true)
    }

    fun toggleVoronoi(show: Boolean) {
        _uiState.update {
            it.copy(kMeansConfig = it.kMeansConfig.copy(showVoronoi = show))
        }
    }

    fun toggleCentroidTrails(show: Boolean) {
        _uiState.update {
            it.copy(kMeansConfig = it.kMeansConfig.copy(showTrails = show))
        }
    }

    fun updateDbscanEpsilon(epsilon: Float) {
        val clamped = epsilon.coerceIn(0.02f, 0.25f)
        pausePlayback()
        _uiState.update {
            it.copy(dbscanConfig = it.dbscanConfig.copy(epsilon = clamped))
        }
        recomputeFrames(jumpToEnd = true)
    }

    fun updateDbscanMinPts(minPts: Int) {
        val clamped = minPts.coerceIn(2, 20)
        pausePlayback()
        _uiState.update {
            it.copy(dbscanConfig = it.dbscanConfig.copy(minPts = clamped))
        }
        recomputeFrames(jumpToEnd = true)
    }

    fun toggleDbscanEpsilonRings(show: Boolean) {
        _uiState.update {
            it.copy(dbscanConfig = it.dbscanConfig.copy(showEpsilonRings = show))
        }
    }

    fun updateSampleCount(count: Int) {
        val clamped = count.coerceIn(40, 360)
        _uiState.update { it.copy(sampleCount = clamped) }
        loadPreset(_uiState.value.selectedPreset, jumpToConverged = true)
    }

    fun updateNoiseSpread(noise: Float) {
        val clamped = noise.coerceIn(0.01f, 0.09f)
        _uiState.update { it.copy(noiseSpread = clamped) }
        loadPreset(_uiState.value.selectedPreset, jumpToConverged = true)
    }

    fun loadPreset(preset: PresetDatasetType, jumpToConverged: Boolean = true) {
        pausePlayback()
        val state = _uiState.value
        randomSeed = System.currentTimeMillis()
        val generated = DatasetGenerator.generate(
            type = preset,
            count = state.sampleCount,
            noiseSpread = state.noiseSpread,
            seed = randomSeed
        )
        nextPointId = (generated.maxOfOrNull { it.id } ?: 0) + 1
        _uiState.update {
            it.copy(
                selectedPreset = preset,
                datasetTitle = preset.title,
                rawPoints = generated,
                lastAddedPointId = null,
                previousCentroids = emptyList(),
                annotations = emptyList(),
                statusBanner = "Loaded ${preset.title} (${generated.size} pts)"
            )
        }
        recomputeFrames(jumpToEnd = jumpToConverged)
    }

    fun addPointAt(normX: Float, normY: Float) {
        pausePlayback()
        val x = normX.coerceIn(0.02f, 0.98f)
        val y = normY.coerceIn(0.02f, 0.98f)
        val newPt = DataPoint(id = nextPointId++, x = x, y = y)
        val oldCentroids = _uiState.value.activeFrame?.centroids.orEmpty()
        _uiState.update { state ->
            state.copy(
                rawPoints = state.rawPoints + newPt,
                previousCentroids = oldCentroids,
                centroidTransitionNonce = state.centroidTransitionNonce + 1,
                lastAddedPointId = newPt.id,
                datasetTitle = if (state.datasetTitle.endsWith("*")) state.datasetTitle else "${state.datasetTitle} *"
            )
        }
        recomputeFrames(jumpToEnd = true)
    }

    fun brushPointsAt(normX: Float, normY: Float) {
        pausePlayback()
        val rng = Random(System.nanoTime())
        val added = List(3) {
            val jx = (normX + (rng.nextFloat() - 0.5f) * 0.045f).coerceIn(0.02f, 0.98f)
            val jy = (normY + (rng.nextFloat() - 0.5f) * 0.045f).coerceIn(0.02f, 0.98f)
            DataPoint(id = nextPointId++, x = jx, y = jy)
        }
        val oldCentroids = _uiState.value.activeFrame?.centroids.orEmpty()
        _uiState.update { state ->
            state.copy(
                rawPoints = state.rawPoints + added,
                previousCentroids = oldCentroids,
                centroidTransitionNonce = state.centroidTransitionNonce + 1,
                lastAddedPointId = added.last().id,
                datasetTitle = if (state.datasetTitle.endsWith("*")) state.datasetTitle else "${state.datasetTitle} *"
            )
        }
        recomputeFrames(jumpToEnd = true)
    }

    fun erasePointsNear(normX: Float, normY: Float, radius: Float = 0.055f) {
        pausePlayback()
        val current = _uiState.value.rawPoints
        val remaining = current.filter { pt ->
            val dx = pt.x - normX
            val dy = pt.y - normY
            sqrt(dx * dx + dy * dy) > radius
        }
        if (remaining.size != current.size) {
            val oldCentroids = _uiState.value.activeFrame?.centroids.orEmpty()
            _uiState.update {
                it.copy(
                    rawPoints = remaining,
                    previousCentroids = oldCentroids,
                    centroidTransitionNonce = it.centroidTransitionNonce + 1,
                    lastAddedPointId = null
                )
            }
            recomputeFrames(jumpToEnd = true)
        }
    }

    fun clearCanvas() {
        pausePlayback()
        _uiState.update {
            it.copy(
                rawPoints = emptyList(),
                previousCentroids = emptyList(),
                lastAddedPointId = null,
                annotations = emptyList(),
                toolMode = CanvasToolMode.ADD,
                datasetTitle = "Custom Canvas",
                statusBanner = "Canvas cleared — tap anywhere on the grid to add points and watch centroids update live."
            )
        }
        recomputeFrames(jumpToEnd = false)
    }

    fun stepForward() {
        pausePlayback()
        _uiState.update { state ->
            val maxIdx = (state.frames.size - 1).coerceAtLeast(0)
            val wrappingToStart = state.currentFrameIndex >= maxIdx
            val nextIdx = if (wrappingToStart) 0 else state.currentFrameIndex + 1
            val departingCentroids = if (wrappingToStart) {
                emptyList()
            } else {
                state.activeFrame?.centroids.orEmpty()
            }
            state.copy(
                currentFrameIndex = nextIdx,
                previousCentroids = departingCentroids,
                centroidTransitionNonce = state.centroidTransitionNonce + 1
            )
        }
    }

    fun stepToFrame(index: Int) {
        pausePlayback()
        _uiState.update { state ->
            val clamped = index.coerceIn(0, (state.frames.size - 1).coerceAtLeast(0))
            if (clamped == state.currentFrameIndex) {
                state
            } else {
                val departingCentroids = if (clamped == 0) {
                    emptyList()
                } else {
                    state.activeFrame?.centroids.orEmpty()
                }
                state.copy(
                    currentFrameIndex = clamped,
                    previousCentroids = departingCentroids,
                    centroidTransitionNonce = state.centroidTransitionNonce + 1
                )
            }
        }
    }

    fun resetToStart() {
        pausePlayback()
        randomSeed = System.currentTimeMillis()
        _uiState.update {
            it.copy(
                previousCentroids = emptyList(),
                centroidTransitionNonce = it.centroidTransitionNonce + 1
            )
        }
        recomputeFrames(jumpToEnd = false)
    }

    fun convergeImmediately() {
        pausePlayback()
        _uiState.update { state ->
            val targetIdx = (state.frames.size - 1).coerceAtLeast(0)
            val departingCentroids = if (targetIdx != state.currentFrameIndex) {
                state.activeFrame?.centroids.orEmpty()
            } else {
                state.previousCentroids
            }
            state.copy(
                currentFrameIndex = targetIdx,
                previousCentroids = departingCentroids,
                centroidTransitionNonce = state.centroidTransitionNonce + 1
            )
        }
    }

    fun togglePlayback() {
        if (_uiState.value.isPlaying) {
            pausePlayback()
        } else {
            startPlayback()
        }
    }

    private fun startPlayback() {
        playbackJob?.cancel()
        val state = _uiState.value
        if (state.frames.size <= 1) return

        if (state.currentFrameIndex >= state.frames.size - 1) {
            _uiState.update {
                it.copy(
                    currentFrameIndex = 0,
                    previousCentroids = emptyList(),
                    centroidTransitionNonce = it.centroidTransitionNonce + 1
                )
            }
        }

        _uiState.update { it.copy(isPlaying = true) }
        playbackJob = viewModelScope.launch {
            while (isActive) {
                // 640ms interval pairs with the 480ms ease-out centroid glide + 160ms settle beat
                delay(640L)
                val current = _uiState.value
                val lastIdx = (current.frames.size - 1).coerceAtLeast(0)
                if (current.currentFrameIndex < lastIdx) {
                    val departingCentroids = current.activeFrame?.centroids.orEmpty()
                    _uiState.update {
                        it.copy(
                            currentFrameIndex = it.currentFrameIndex + 1,
                            previousCentroids = departingCentroids,
                            centroidTransitionNonce = it.centroidTransitionNonce + 1
                        )
                    }
                } else {
                    _uiState.update { it.copy(isPlaying = false) }
                    break
                }
            }
        }
    }

    private fun pausePlayback() {
        playbackJob?.cancel()
        playbackJob = null
        if (_uiState.value.isPlaying) {
            _uiState.update { it.copy(isPlaying = false) }
        }
    }

    fun saveCurrentSnapshot(title: String) {
        val state = _uiState.value
        if (state.rawPoints.isEmpty()) {
            _uiState.update { it.copy(statusBanner = "Add points before saving a snapshot.") }
            return
        }
        viewModelScope.launch {
            repository?.saveSnapshot(
                title = title.ifBlank { state.datasetTitle },
                algorithm = state.algorithm,
                points = state.rawPoints,
                kValue = state.kMeansConfig.k,
                epsilonValue = state.dbscanConfig.epsilon,
                minPtsValue = state.dbscanConfig.minPts
            )
            _uiState.update {
                it.copy(
                    datasetTitle = title.ifBlank { state.datasetTitle },
                    statusBanner = "Saved snapshot '${title.ifBlank { state.datasetTitle }}' locally."
                )
            }
        }
    }

    fun loadSavedSnapshot(entity: SavedDatasetEntity) {
        pausePlayback()
        val points = repository?.deserializePoints(entity.pointsSerialized).orEmpty()
        if (points.isEmpty()) return
        val algo = runCatching { AlgorithmType.valueOf(entity.algorithm) }
            .getOrDefault(AlgorithmType.KMEANS)
        nextPointId = (points.maxOfOrNull { it.id } ?: 0) + 1
        _uiState.update { state ->
            state.copy(
                datasetTitle = entity.title,
                algorithm = algo,
                rawPoints = points,
                previousCentroids = emptyList(),
                lastAddedPointId = null,
                annotations = emptyList(),
                kMeansConfig = state.kMeansConfig.copy(k = entity.kValue.coerceIn(2, 10)),
                dbscanConfig = state.dbscanConfig.copy(
                    epsilon = entity.epsilonValue.coerceIn(0.02f, 0.25f),
                    minPts = entity.minPtsValue.coerceIn(2, 20)
                ),
                statusBanner = "Loaded snapshot '${entity.title}' (${points.size} pts)"
            )
        }
        recomputeFrames(jumpToEnd = true)
    }

    fun deleteSavedSnapshot(id: Int) {
        viewModelScope.launch {
            repository?.deleteSnapshot(id)
        }
    }

    fun importRawTextData(rawText: String, sourceLabel: String = "Imported Data"): Boolean {
        pausePlayback()
        val parsed = DatasetGenerator.parseRawTextToPoints(rawText)
        if (parsed.isEmpty()) {
            _uiState.update {
                it.copy(statusBanner = "Could not find numeric (x, y) pairs in input.")
            }
            return false
        }
        nextPointId = (parsed.maxOfOrNull { it.id } ?: 0) + 1
        _uiState.update {
            it.copy(
                datasetTitle = sourceLabel,
                rawPoints = parsed,
                previousCentroids = emptyList(),
                lastAddedPointId = null,
                annotations = emptyList(),
                statusBanner = "Imported ${parsed.size} 2D points into '$sourceLabel'."
            )
        }
        recomputeFrames(jumpToEnd = true)
        return true
    }

    fun exportCurrentPointsCsv(): String {
        val state = _uiState.value
        val pts = state.activeFrame?.points ?: state.rawPoints
        val centroids = state.activeFrame?.centroids.orEmpty()
        return DatasetGenerator.exportPointsToCsv(
            points = pts,
            centroids = centroids,
            datasetTitle = state.datasetTitle
        )
    }

    fun postStatusBanner(message: String) {
        _uiState.update { it.copy(statusBanner = message) }
    }

    fun dismissBanner() {
        _uiState.update { it.copy(statusBanner = null) }
    }

    private fun applyComputedFramesAndRecordHistory(
        snapshot: ClusteringUiState,
        computed: List<ClusteringStepFrame>,
        jumpToEnd: Boolean,
        seedUsed: Long
    ) {
        val targetIndex = if (jumpToEnd) {
            (computed.size - 1).coerceAtLeast(0)
        } else {
            0
        }
        val finalFrame = computed.lastOrNull()
        _uiState.update { current ->
            var updatedHistory = current.sessionHistory
            var updatedActiveRunId = current.activeHistoryRunId

            if (snapshot.rawPoints.isNotEmpty() && finalFrame != null) {
                val top = updatedHistory.firstOrNull()
                val isDuplicateOfLatest = top != null &&
                    top.algorithm == snapshot.algorithm &&
                    top.datasetTitle == snapshot.datasetTitle &&
                    top.rawPoints.size == snapshot.rawPoints.size &&
                    top.kMeansConfig.k == snapshot.kMeansConfig.k &&
                    top.dbscanConfig.epsilon == snapshot.dbscanConfig.epsilon &&
                    top.dbscanConfig.minPts == snapshot.dbscanConfig.minPts &&
                    top.randomSeed == seedUsed &&
                    kotlin.math.abs(top.inertiaWcss - finalFrame.wcss) < 0.00005f

                if (!isDuplicateOfLatest) {
                    val newRun = ClusteringSessionRun(
                        runId = nextHistoryRunId++,
                        timestampMillis = System.currentTimeMillis(),
                        datasetTitle = snapshot.datasetTitle,
                        algorithm = snapshot.algorithm,
                        kMeansConfig = snapshot.kMeansConfig,
                        dbscanConfig = snapshot.dbscanConfig,
                        rawPoints = snapshot.rawPoints,
                        frames = computed,
                        inertiaWcss = finalFrame.wcss,
                        silhouetteScore = finalFrame.silhouetteScore,
                        clusterCount = finalFrame.clusterSummaries.size,
                        noiseCount = finalFrame.noiseCount,
                        randomSeed = seedUsed,
                        annotations = current.annotations
                    )
                    updatedHistory = (listOf(newRun) + updatedHistory).take(MAX_SESSION_HISTORY)
                    updatedActiveRunId = newRun.runId
                }
            }

            current.copy(
                frames = computed,
                currentFrameIndex = targetIndex,
                sessionHistory = updatedHistory,
                activeHistoryRunId = updatedActiveRunId
            )
        }
    }

    /**
     * Real-time adaptive clustering computation:
     * - For small interactive datasets (`<= 200` points), runs synchronously on the calling
     *   thread so tapping on the Canvas updates points and centroids with zero frame latency.
     * - For larger datasets (`> 200` points), dispatches to a background coroutine on
     *   [Dispatchers.Default] with cooperative cancellation.
     */
    private fun recomputeFrames(jumpToEnd: Boolean) {
        computeJob?.cancel()
        val snapshot = _uiState.value
        val seedUsed = randomSeed
        if (snapshot.rawPoints.size <= 200) {
            val computed = when (snapshot.algorithm) {
                AlgorithmType.KMEANS -> ClusteringEngine.computeKMeansFrames(
                    rawPoints = snapshot.rawPoints,
                    config = snapshot.kMeansConfig,
                    seed = seedUsed
                )
                AlgorithmType.DBSCAN -> ClusteringEngine.computeDbscanFrames(
                    rawPoints = snapshot.rawPoints,
                    config = snapshot.dbscanConfig
                )
            }
            applyComputedFramesAndRecordHistory(snapshot, computed, jumpToEnd, seedUsed)
        } else {
            computeJob = viewModelScope.launch {
                val computed = when (snapshot.algorithm) {
                    AlgorithmType.KMEANS -> ClusteringEngine.computeKMeansFramesAdaptive(
                        rawPoints = snapshot.rawPoints,
                        config = snapshot.kMeansConfig,
                        seed = seedUsed,
                        smallDatasetThreshold = 200
                    )
                    AlgorithmType.DBSCAN -> ClusteringEngine.computeDbscanFramesAdaptive(
                        rawPoints = snapshot.rawPoints,
                        config = snapshot.dbscanConfig,
                        smallDatasetThreshold = 200
                    )
                }
                applyComputedFramesAndRecordHistory(snapshot, computed, jumpToEnd, seedUsed)
            }
        }
    }

    class Factory(
        private val repository: DatasetRepository?,
        private val themePreferences: ThemePreferencesRepository? = null
    ) : ViewModelProvider.Factory {
        @Suppress("UNCHECKED_CAST")
        override fun <T : ViewModel> create(modelClass: Class<T>): T {
            return ClusteringViewModel(repository, themePreferences) as T
        }
    }
}
