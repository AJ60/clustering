package com.example.ui

import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.HelpOutline
import androidx.compose.material.icons.outlined.BookmarkAdd
import androidx.compose.material.icons.outlined.Bookmarks
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.ContentPaste
import androidx.compose.material.icons.outlined.Devices
import androidx.compose.material.icons.outlined.DynamicFeed
import androidx.compose.material.icons.outlined.FileDownload
import androidx.compose.material.icons.outlined.FileOpen
import androidx.compose.material.icons.outlined.History
import androidx.compose.material.icons.outlined.PictureAsPdf
import androidx.compose.material.icons.outlined.Settings
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
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInWindow
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.example.R
import com.example.data.BatchPdfReportGenerator
import com.example.data.LocalCsvFileInfo
import com.example.data.LocalCsvFileManager
import com.example.data.LocalPdfReportInfo
import com.example.data.PdfReportGenerator
import com.example.data.PdfReportInput
import com.example.model.ClusterAnnotation
import com.example.ui.components.AlgorithmAndHyperparametersCard
import com.example.ui.components.BatchProcessingDialog
import com.example.ui.components.BatchProcessingQuickCard
import com.example.ui.components.CanvasToolbarAndPlaybackBar
import com.example.ui.components.ClusterAnnotationDialog
import com.example.ui.components.CoachMarkTargets
import com.example.ui.components.CsvStorageManagerDialog
import com.example.ui.components.InteractiveClusterCanvas
import com.example.ui.components.InteractiveCoachMarkOverlay
import com.example.ui.components.LocalCsvStorageCard
import com.example.ui.components.MetricsInspectorCard
import com.example.ui.components.PasteDatasetDialog
import com.example.ui.components.PdfReportExportCard
import com.example.ui.components.PdfReportManagerDialog
import com.example.ui.components.PresetDatasetSelectorCard
import com.example.ui.components.SaveSnapshotDialog
import com.example.ui.components.SavedSnapshotsDialog
import com.example.ui.components.SessionHistoryDialog
import com.example.ui.components.SessionHistoryStripCard
import com.example.ui.components.SettingsMenuDialog
import com.example.ui.components.UserGuideDialog

private data class PendingAnnotationTarget(
    val clusterId: Int,
    val x: Float,
    val y: Float,
    val existingAnnotation: ClusterAnnotation?
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ClusteringStudioScreen(
    viewModel: ClusteringViewModel,
    modifier: Modifier = Modifier
) {
    val uiState by viewModel.uiState.collectAsStateWithLifecycle()
    val savedDatasets by viewModel.savedDatasets.collectAsStateWithLifecycle()
    val context = LocalContext.current

    var showSaveDialog by remember { mutableStateOf(false) }
    var showSavedListDialog by remember { mutableStateOf(false) }
    var showPasteDialog by remember { mutableStateOf(false) }
    var showCsvManagerDialog by remember { mutableStateOf(false) }
    var showPdfManagerDialog by remember { mutableStateOf(false) }
    var showSessionHistoryDialog by remember { mutableStateOf(false) }
    var showBatchDialog by remember { mutableStateOf(false) }
    var showSettingsDialog by remember { mutableStateOf(false) }
    var showUserGuideDialog by remember { mutableStateOf(false) }
    var showHardenedRpcDashboard by remember { mutableStateOf(false) }
    var pendingAnnotationTarget by remember { mutableStateOf<PendingAnnotationTarget?>(null) }
    var localCsvFiles by remember { mutableStateOf<List<LocalCsvFileInfo>>(emptyList()) }
    var localPdfReports by remember { mutableStateOf<List<LocalPdfReportInfo>>(emptyList()) }
    var pendingBatchExportTitle by remember { mutableStateOf("ClusterLab_Batch_Summary") }

    LaunchedEffect(Unit, showCsvManagerDialog) {
        localCsvFiles = LocalCsvFileManager.listLocalCsvFiles(context)
    }

    LaunchedEffect(Unit, showPdfManagerDialog, showBatchDialog) {
        localPdfReports = PdfReportGenerator.listLocalPdfReports(context)
    }

    BackHandler(
        enabled = showSaveDialog ||
            showSavedListDialog ||
            showPasteDialog ||
            showCsvManagerDialog ||
            showPdfManagerDialog ||
            showSessionHistoryDialog ||
            showBatchDialog ||
            showSettingsDialog ||
            showUserGuideDialog ||
            pendingAnnotationTarget != null ||
            showHardenedRpcDashboard
    ) {
        if (pendingAnnotationTarget != null) {
            pendingAnnotationTarget = null
        } else if (showSaveDialog ||
            showSavedListDialog ||
            showPasteDialog ||
            showCsvManagerDialog ||
            showPdfManagerDialog ||
            showSessionHistoryDialog ||
            showBatchDialog ||
            showSettingsDialog ||
            showUserGuideDialog
        ) {
            showSaveDialog = false
            showSavedListDialog = false
            showPasteDialog = false
            showCsvManagerDialog = false
            showPdfManagerDialog = false
            showSessionHistoryDialog = false
            if (!uiState.batchState.isRunning) {
                showBatchDialog = false
            }
            showSettingsDialog = false
            showUserGuideDialog = false
        } else {
            showHardenedRpcDashboard = false
        }
    }

    val activeFrame = uiState.activeFrame
    val displayPoints = activeFrame?.points ?: uiState.rawPoints
    val displayCentroids = activeFrame?.centroids.orEmpty()

    fun buildPdfReportInput(): PdfReportInput {
        val currentState = viewModel.uiState.value
        val currentFrame = currentState.activeFrame
        return PdfReportInput(
            datasetTitle = currentState.datasetTitle,
            algorithm = currentState.algorithm,
            kMeansConfig = currentState.kMeansConfig,
            dbscanConfig = currentState.dbscanConfig,
            points = currentFrame?.points ?: currentState.rawPoints,
            centroids = currentFrame?.centroids.orEmpty(),
            frame = currentFrame,
            showVoronoi = currentState.kMeansConfig.showVoronoi,
            showTrails = currentState.kMeansConfig.showTrails,
            showSpiderLines = currentState.showSpiderLines,
            showEpsilonRings = currentState.dbscanConfig.showEpsilonRings,
            annotations = currentState.annotations
        )
    }

    // Zero-permission SAF Document Picker for importing CSV or JSON point clouds
    val importFileLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.OpenDocument()
    ) { uri ->
        if (uri != null) {
            runCatching {
                context.contentResolver.openInputStream(uri)?.bufferedReader()?.use { it.readText() }
            }.getOrNull()?.let { text ->
                val fileName = uri.lastPathSegment?.substringAfterLast('/') ?: "Imported_Dataset.csv"
                if (viewModel.importRawTextData(text, fileName.removeSuffix(".csv"))) {
                    val savedInfo = LocalCsvFileManager.saveCsvToLocalDevice(
                        context = context,
                        desiredName = fileName,
                        points = viewModel.uiState.value.rawPoints,
                        centroids = viewModel.uiState.value.activeFrame?.centroids.orEmpty()
                    )
                    localCsvFiles = LocalCsvFileManager.listLocalCsvFiles(context)
                    viewModel.postStatusBanner("Imported & cached '${savedInfo.fileName}' (${savedInfo.pointCount} pts) to local storage.")
                }
            }
        }
    }

    // Zero-permission SAF Document Creator for exporting clustered CSV points
    val exportCsvLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.CreateDocument("text/csv")
    ) { uri ->
        if (uri != null) {
            val csv = viewModel.exportCurrentPointsCsv()
            runCatching {
                context.contentResolver.openOutputStream(uri)?.bufferedWriter()?.use {
                    it.write(csv)
                }
                viewModel.postStatusBanner("Exported CSV dataset (${uiState.rawPoints.size} pts) to device storage.")
            }
        }
    }

    // Zero-permission SAF Document Creator for exporting PDF summary reports to user-chosen folder
    val exportPdfLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.CreateDocument("application/pdf")
    ) { uri ->
        if (uri != null) {
            val reportInput = buildPdfReportInput()
            val savedOk = runCatching {
                context.contentResolver.openOutputStream(uri)?.use { out ->
                    PdfReportGenerator.writePdfReportToStream(reportInput, out)
                }
                true
            }.getOrDefault(false)
            if (savedOk) {
                viewModel.postStatusBanner(
                    "Exported PDF summary report for '${reportInput.datasetTitle}' (${reportInput.points.size} pts) to chosen folder."
                )
            } else {
                viewModel.postStatusBanner("Could not write PDF report to selected folder.")
            }
        }
    }

    // Zero-permission SAF Document Creator for exporting the combined Batch PDF summary report
    val exportBatchPdfLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.CreateDocument("application/pdf")
    ) { uri ->
        if (uri != null) {
            val batchInput = viewModel.buildBatchPdfReportInput(pendingBatchExportTitle)
            val savedOk = runCatching {
                context.contentResolver.openOutputStream(uri)?.use { out ->
                    BatchPdfReportGenerator.writeCombinedBatchPdfToStream(batchInput, out)
                }
                true
            }.getOrDefault(false)
            if (savedOk) {
                viewModel.postStatusBanner(
                    "Exported combined batch PDF (${batchInput.completedItems.size} runs) to chosen folder."
                )
            } else {
                viewModel.postStatusBanner("Could not write combined batch PDF to selected folder.")
            }
        }
    }

    val clusterCount = activeFrame?.clusterSummaries?.size
        ?: displayPoints.map { it.clusterId }.filter { it >= 0 }.distinct().size
    val silhouetteScore = activeFrame?.silhouetteScore ?: 0f
    val inertiaWcss = activeFrame?.wcss ?: 0f
    val noiseCount = activeFrame?.noiseCount ?: 0
    val isDevMode = uiState.developerModeEnabled

    var rootWindowOffset by remember { mutableStateOf(Offset.Zero) }
    var coachTargets by remember { mutableStateOf(CoachMarkTargets()) }

    fun Rect.relativeToRoot(): Rect = translate(-rootWindowOffset.x, -rootWindowOffset.y)

    Box(
        modifier = modifier
            .fillMaxSize()
            .onGloballyPositioned { coords ->
                rootWindowOffset = coords.positionInWindow()
            }
    ) {
    Scaffold(
        modifier = Modifier.fillMaxSize(),
        contentWindowInsets = WindowInsets.safeDrawing,
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(
                            text = if (showHardenedRpcDashboard) {
                                "${stringResource(R.string.app_name)} — Connect Phone"
                            } else {
                                "${stringResource(R.string.app_name)} — ${uiState.datasetTitle}"
                            },
                            style = MaterialTheme.typography.titleLarge,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis
                        )
                        Text(
                            text = if (showHardenedRpcDashboard) {
                                "Auto-Tuned Helper • Safe Background Sharing"
                            } else {
                                stringResource(R.string.studio_subtitle)
                            },
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis
                        )
                    }
                },
                actions = {
                    if (!showHardenedRpcDashboard && isDevMode) {
                        IconButton(
                            onClick = { showPasteDialog = true },
                            modifier = Modifier.testTag("top_action_paste_data")
                        ) {
                            Icon(
                                imageVector = Icons.Outlined.ContentPaste,
                                contentDescription = stringResource(R.string.action_paste_data)
                            )
                        }
                        IconButton(
                            onClick = {
                                importFileLauncher.launch(
                                    arrayOf("text/csv", "text/comma-separated-values", "application/json", "text/plain", "*/*")
                                )
                            },
                            modifier = Modifier.testTag("top_action_import_file")
                        ) {
                            Icon(
                                imageVector = Icons.Outlined.FileOpen,
                                contentDescription = stringResource(R.string.action_import_file)
                            )
                        }
                        IconButton(
                            onClick = {
                                val sanitized = uiState.datasetTitle.replace(Regex("[^a-zA-Z0-9_-]"), "_")
                                exportCsvLauncher.launch("${sanitized}_clusters.csv")
                            },
                            modifier = Modifier.testTag("top_action_export_csv")
                        ) {
                            Icon(
                                imageVector = Icons.Outlined.FileDownload,
                                contentDescription = stringResource(R.string.action_export_csv)
                            )
                        }
                        IconButton(
                            onClick = { showSaveDialog = true },
                            modifier = Modifier.testTag("top_action_save_snapshot")
                        ) {
                            Icon(
                                imageVector = Icons.Outlined.BookmarkAdd,
                                contentDescription = stringResource(R.string.action_save_workspace)
                            )
                        }
                        IconButton(
                            onClick = { showSavedListDialog = true },
                            modifier = Modifier.testTag("top_action_open_snapshots")
                        ) {
                            Icon(
                                imageVector = Icons.Outlined.Bookmarks,
                                contentDescription = stringResource(R.string.action_saved_workspaces)
                            )
                        }
                    }
                    if (!showHardenedRpcDashboard) {
                        IconButton(
                            onClick = { showBatchDialog = true },
                            modifier = Modifier.testTag("top_action_batch_processing")
                        ) {
                            Icon(
                                imageVector = Icons.Outlined.DynamicFeed,
                                contentDescription = stringResource(R.string.action_batch_processing)
                            )
                        }
                        IconButton(
                            onClick = { showSessionHistoryDialog = true },
                            modifier = Modifier.testTag("top_action_session_history")
                        ) {
                            Icon(
                                imageVector = Icons.Outlined.History,
                                contentDescription = stringResource(R.string.action_session_history)
                            )
                        }
                        IconButton(
                            onClick = { showPdfManagerDialog = true },
                            modifier = Modifier.testTag("top_action_export_pdf")
                        ) {
                            Icon(
                                imageVector = Icons.Outlined.PictureAsPdf,
                                contentDescription = stringResource(R.string.action_export_pdf)
                            )
                        }
                    }
                    IconButton(
                        onClick = { showUserGuideDialog = true },
                        modifier = Modifier.testTag("top_action_user_guide")
                    ) {
                        Icon(
                            imageVector = Icons.AutoMirrored.Outlined.HelpOutline,
                            contentDescription = stringResource(R.string.action_user_guide)
                        )
                    }
                    IconButton(
                        onClick = { showSettingsDialog = true },
                        modifier = Modifier.testTag("top_action_settings")
                    ) {
                        Icon(
                            imageVector = Icons.Outlined.Settings,
                            contentDescription = stringResource(R.string.action_settings)
                        )
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.background
                )
            )
        },
        bottomBar = {
            NavigationBar(
                containerColor = MaterialTheme.colorScheme.surface
            ) {
                NavigationBarItem(
                    selected = !showHardenedRpcDashboard,
                    onClick = { showHardenedRpcDashboard = false },
                    icon = {
                        Icon(
                            imageVector = Icons.Outlined.Bookmarks,
                            contentDescription = "2D Clustering Lab"
                        )
                    },
                    label = { Text("2D Lab") },
                    modifier = Modifier.testTag("nav_tab_2d_clustering")
                )
                NavigationBarItem(
                    selected = showHardenedRpcDashboard,
                    onClick = { showHardenedRpcDashboard = true },
                    icon = {
                        Icon(
                            imageVector = Icons.Outlined.Devices,
                            contentDescription = "Connect Phone to Cluster"
                        )
                    },
                    label = { Text("Connect Phone") },
                    modifier = Modifier.testTag("nav_tab_connect_node")
                )
            }
        }
    ) { innerPadding ->
        BoxWithConstraints(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding)
                .padding(horizontal = 14.dp, vertical = 6.dp)
        ) {
            val isWideScreen = maxWidth >= 760.dp

            Column(modifier = Modifier.fillMaxSize()) {
                if (showHardenedRpcDashboard) {
                    com.example.ui.components.HardenedNodeDashboard(
                        modifier = Modifier.fillMaxSize(),
                        developerModeEnabled = isDevMode,
                        onToggleDeveloperMode = viewModel::setDeveloperMode
                    )
                    return@Column
                }
                // Status toast banner for imports/saves
                AnimatedVisibility(visible = uiState.statusBanner != null) {
                    uiState.statusBanner?.let { banner ->
                        Surface(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(bottom = 8.dp),
                            shape = RoundedCornerShape(12.dp),
                            color = MaterialTheme.colorScheme.primaryContainer
                        ) {
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(horizontal = 12.dp, vertical = 6.dp),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.SpaceBetween
                            ) {
                                Text(
                                    text = banner,
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onPrimaryContainer,
                                    modifier = Modifier.weight(1f)
                                )
                                IconButton(
                                    onClick = viewModel::dismissBanner,
                                    modifier = Modifier.testTag("dismiss_banner_button")
                                ) {
                                    Icon(
                                        imageVector = Icons.Outlined.Close,
                                        contentDescription = "Dismiss notification",
                                        tint = MaterialTheme.colorScheme.onPrimaryContainer
                                    )
                                }
                            }
                        }
                    }
                }

                if (isWideScreen) {
                    // Canonical Two-Pane Side-by-Side Workspace for Tablets & Foldables
                    Row(
                        modifier = Modifier.fillMaxSize(),
                        horizontalArrangement = Arrangement.spacedBy(16.dp)
                    ) {
                        Column(
                            modifier = Modifier
                                .weight(1.35f)
                                .fillMaxHeight(),
                            verticalArrangement = Arrangement.spacedBy(10.dp)
                        ) {
                            val legacyGraphicsMode = remember(context) {
                                com.example.service.HardwareProbe
                                    .detectLegacyHardwareProfile(context)
                                    .legacyGraphicsMode
                            }
                            InteractiveClusterCanvas(
                                points = displayPoints,
                                centroids = displayCentroids,
                                algorithm = uiState.algorithm,
                                toolMode = uiState.toolMode,
                                showGrid = uiState.showGrid,
                                showVoronoi = uiState.kMeansConfig.showVoronoi,
                                showTrails = uiState.kMeansConfig.showTrails,
                                showEpsilonRings = uiState.dbscanConfig.showEpsilonRings,
                                epsilonRadius = uiState.dbscanConfig.epsilon,
                                isDarkTheme = uiState.isDarkTheme,
                                onAddPoint = viewModel::addPointAt,
                                onBrushPoint = viewModel::brushPointsAt,
                                onErasePoint = viewModel::erasePointsNear,
                                onToggleGrid = viewModel::toggleGrid,
                                previousCentroids = uiState.previousCentroids,
                                lastAddedPointId = uiState.lastAddedPointId,
                                showSpiderLines = uiState.showSpiderLines,
                                onToggleSpiderLines = viewModel::toggleSpiderLines,
                                silhouetteScore = silhouetteScore,
                                inertiaWcss = inertiaWcss,
                                noiseCount = noiseCount,
                                developerModeEnabled = isDevMode,
                                legacyGraphicsMode = legacyGraphicsMode,
                                currentIteration = uiState.currentFrameIndex,
                                totalIterations = uiState.totalFrames,
                                isConverged = activeFrame?.isConverged == true,
                                isPlaying = uiState.isPlaying,
                                transitionNonce = uiState.centroidTransitionNonce,
                                annotations = uiState.annotations,
                                onLongPressClusterArea = { cid, wx, wy, existing ->
                                    pendingAnnotationTarget = PendingAnnotationTarget(
                                        clusterId = cid,
                                        x = wx,
                                        y = wy,
                                        existingAnnotation = existing
                                    )
                                },
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .weight(1f)
                                    .onGloballyPositioned { coords ->
                                        coachTargets = coachTargets.copy(
                                            canvasBounds = coords.boundsInWindow().relativeToRoot()
                                        )
                                    }
                            )

                            CanvasToolbarAndPlaybackBar(
                                toolMode = uiState.toolMode,
                                isPlaying = uiState.isPlaying,
                                currentFrameIndex = uiState.currentFrameIndex,
                                totalFrames = uiState.totalFrames,
                                stepDescription = activeFrame?.description.orEmpty(),
                                isConverged = activeFrame?.isConverged == true,
                                onSelectTool = viewModel::selectToolMode,
                                onTogglePlay = viewModel::togglePlayback,
                                onStepForward = viewModel::stepForward,
                                onReset = viewModel::resetToStart,
                                onConvergeInstant = viewModel::convergeImmediately,
                                onClearCanvas = viewModel::clearCanvas,
                                developerModeEnabled = isDevMode,
                                onRunClustering = viewModel::runClusteringAnimationFromStart,
                                gestureToolsModifier = Modifier.onGloballyPositioned { coords ->
                                    coachTargets = coachTargets.copy(
                                        gestureControlsBounds = coords.boundsInWindow().relativeToRoot()
                                    )
                                },
                                runButtonModifier = Modifier.onGloballyPositioned { coords ->
                                    coachTargets = coachTargets.copy(
                                        runButtonBounds = coords.boundsInWindow().relativeToRoot()
                                    )
                                }
                            )
                        }

                        Column(
                            modifier = Modifier
                                .weight(1f)
                                .fillMaxHeight()
                                .verticalScroll(rememberScrollState()),
                            verticalArrangement = Arrangement.spacedBy(12.dp)
                        ) {
                            AlgorithmAndHyperparametersCard(
                                algorithm = uiState.algorithm,
                                kMeansConfig = uiState.kMeansConfig,
                                dbscanConfig = uiState.dbscanConfig,
                                onSelectAlgorithm = viewModel::selectAlgorithm,
                                onUpdateK = viewModel::updateKMeansK,
                                onToggleKMeansPlusPlus = viewModel::toggleKMeansPlusPlus,
                                onToggleVoronoi = viewModel::toggleVoronoi,
                                onToggleTrails = viewModel::toggleCentroidTrails,
                                onUpdateEpsilon = viewModel::updateDbscanEpsilon,
                                onUpdateMinPts = viewModel::updateDbscanMinPts,
                                onToggleEpsilonRings = viewModel::toggleDbscanEpsilonRings,
                                developerModeEnabled = isDevMode
                            )

                            SessionHistoryStripCard(
                                history = uiState.sessionHistory,
                                activeRunId = uiState.activeHistoryRunId,
                                onRestoreRun = viewModel::restoreSessionRun,
                                onOpenFullHistory = { showSessionHistoryDialog = true }
                            )

                            PresetDatasetSelectorCard(
                                selectedPreset = uiState.selectedPreset,
                                sampleCount = uiState.sampleCount,
                                noiseSpread = uiState.noiseSpread,
                                onSelectPreset = { viewModel.loadPreset(it) },
                                onUpdateSampleCount = viewModel::updateSampleCount,
                                onUpdateNoiseSpread = viewModel::updateNoiseSpread,
                                developerModeEnabled = isDevMode
                            )

                            PdfReportExportCard(
                                datasetTitle = uiState.datasetTitle,
                                algorithmName = uiState.algorithm.displayName,
                                pointCount = displayPoints.size,
                                clusterCount = clusterCount,
                                silhouetteScore = silhouetteScore,
                                savedPdfCount = localPdfReports.size,
                                onQuickSaveLocalPdf = {
                                    val saved = PdfReportGenerator.savePdfReportToLocalDevice(
                                        context = context,
                                        input = buildPdfReportInput(),
                                        desiredName = uiState.datasetTitle
                                    )
                                    localPdfReports = PdfReportGenerator.listLocalPdfReports(context)
                                    viewModel.postStatusBanner(
                                        "Saved PDF report '${saved.fileName}' (${saved.formattedSize}) to local device storage."
                                    )
                                },
                                onOpenPdfManager = { showPdfManagerDialog = true },
                                onExportPdfToFolder = {
                                    exportPdfLauncher.launch(
                                        PdfReportGenerator.sanitizePdfFileName(uiState.datasetTitle)
                                    )
                                }
                            )

                            BatchProcessingQuickCard(
                                batchState = uiState.batchState,
                                onQueueCurrentCanvas = viewModel::enqueueCurrentCanvasForBatch,
                                onOpenBatchDialog = { showBatchDialog = true },
                                onOpenCombinedPdf = { fileName ->
                                    val opened = PdfReportGenerator.openLocalPdfReport(context, fileName)
                                    if (!opened) {
                                        viewModel.postStatusBanner(
                                            "No PDF viewer app found to open '$fileName'. Use Share or Save instead."
                                        )
                                    }
                                },
                                onShareCombinedPdf = { fileName ->
                                    PdfReportGenerator.shareLocalPdfReport(context, fileName)
                                }
                            )

                            if (isDevMode) {
                                MetricsInspectorCard(
                                    algorithm = uiState.algorithm,
                                    frame = activeFrame
                                )

                                LocalCsvStorageCard(
                                    datasetTitle = uiState.datasetTitle,
                                    pointCount = displayPoints.size,
                                    savedCsvCount = localCsvFiles.size,
                                    onQuickSaveLocalCsv = {
                                        val info = LocalCsvFileManager.saveCsvToLocalDevice(
                                            context = context,
                                            desiredName = uiState.datasetTitle,
                                            points = displayPoints,
                                            centroids = displayCentroids
                                        )
                                        localCsvFiles = LocalCsvFileManager.listLocalCsvFiles(context)
                                        viewModel.postStatusBanner(
                                            "Saved '${info.fileName}' (${info.pointCount} pts, ${info.formattedSize}) to local device storage."
                                        )
                                    },
                                    onOpenCsvManager = { showCsvManagerDialog = true },
                                    onExportCsvToSystemStorage = {
                                        exportCsvLauncher.launch(
                                            LocalCsvFileManager.sanitizeFileName(uiState.datasetTitle)
                                        )
                                    },
                                    onShareCsvDataset = {
                                        LocalCsvFileManager.shareCsvDatasetText(
                                            context = context,
                                            datasetTitle = uiState.datasetTitle,
                                            csvContent = viewModel.exportCurrentPointsCsv()
                                        )
                                    }
                                )
                            }
                            Spacer(modifier = Modifier.height(16.dp))
                        }
                    }
                } else {
                    // Compact Vertical Studio Layout for Phones
                    Column(
                        modifier = Modifier
                            .fillMaxSize()
                            .verticalScroll(rememberScrollState()),
                        verticalArrangement = Arrangement.spacedBy(12.dp)
                    ) {
                        val legacyGraphicsMode = remember(context) {
                            com.example.service.HardwareProbe
                                .detectLegacyHardwareProfile(context)
                                .legacyGraphicsMode
                        }
                        InteractiveClusterCanvas(
                            points = displayPoints,
                            centroids = displayCentroids,
                            algorithm = uiState.algorithm,
                            toolMode = uiState.toolMode,
                            showGrid = uiState.showGrid,
                            showVoronoi = uiState.kMeansConfig.showVoronoi,
                            showTrails = uiState.kMeansConfig.showTrails,
                            showEpsilonRings = uiState.dbscanConfig.showEpsilonRings,
                            epsilonRadius = uiState.dbscanConfig.epsilon,
                            isDarkTheme = uiState.isDarkTheme,
                            onAddPoint = viewModel::addPointAt,
                            onBrushPoint = viewModel::brushPointsAt,
                            onErasePoint = viewModel::erasePointsNear,
                            onToggleGrid = viewModel::toggleGrid,
                            previousCentroids = uiState.previousCentroids,
                            lastAddedPointId = uiState.lastAddedPointId,
                            showSpiderLines = uiState.showSpiderLines,
                            onToggleSpiderLines = viewModel::toggleSpiderLines,
                            silhouetteScore = silhouetteScore,
                            inertiaWcss = inertiaWcss,
                            noiseCount = noiseCount,
                            developerModeEnabled = isDevMode,
                            legacyGraphicsMode = legacyGraphicsMode,
                            currentIteration = uiState.currentFrameIndex,
                            totalIterations = uiState.totalFrames,
                            isConverged = activeFrame?.isConverged == true,
                            isPlaying = uiState.isPlaying,
                            transitionNonce = uiState.centroidTransitionNonce,
                            annotations = uiState.annotations,
                            onLongPressClusterArea = { cid, wx, wy, existing ->
                                pendingAnnotationTarget = PendingAnnotationTarget(
                                    clusterId = cid,
                                    x = wx,
                                    y = wy,
                                    existingAnnotation = existing
                                )
                            },
                            modifier = Modifier
                                .fillMaxWidth()
                                .height(350.dp)
                                .onGloballyPositioned { coords ->
                                    coachTargets = coachTargets.copy(
                                        canvasBounds = coords.boundsInWindow().relativeToRoot()
                                    )
                                }
                        )

                        CanvasToolbarAndPlaybackBar(
                            toolMode = uiState.toolMode,
                            isPlaying = uiState.isPlaying,
                            currentFrameIndex = uiState.currentFrameIndex,
                            totalFrames = uiState.totalFrames,
                            stepDescription = activeFrame?.description.orEmpty(),
                            isConverged = activeFrame?.isConverged == true,
                            onSelectTool = viewModel::selectToolMode,
                            onTogglePlay = viewModel::togglePlayback,
                            onStepForward = viewModel::stepForward,
                            onReset = viewModel::resetToStart,
                            onConvergeInstant = viewModel::convergeImmediately,
                            onClearCanvas = viewModel::clearCanvas,
                            developerModeEnabled = isDevMode,
                            onRunClustering = viewModel::runClusteringAnimationFromStart,
                            gestureToolsModifier = Modifier.onGloballyPositioned { coords ->
                                coachTargets = coachTargets.copy(
                                    gestureControlsBounds = coords.boundsInWindow().relativeToRoot()
                                )
                            },
                            runButtonModifier = Modifier.onGloballyPositioned { coords ->
                                coachTargets = coachTargets.copy(
                                    runButtonBounds = coords.boundsInWindow().relativeToRoot()
                                )
                            }
                        )

                        AlgorithmAndHyperparametersCard(
                            algorithm = uiState.algorithm,
                            kMeansConfig = uiState.kMeansConfig,
                            dbscanConfig = uiState.dbscanConfig,
                            onSelectAlgorithm = viewModel::selectAlgorithm,
                            onUpdateK = viewModel::updateKMeansK,
                            onToggleKMeansPlusPlus = viewModel::toggleKMeansPlusPlus,
                            onToggleVoronoi = viewModel::toggleVoronoi,
                            onToggleTrails = viewModel::toggleCentroidTrails,
                            onUpdateEpsilon = viewModel::updateDbscanEpsilon,
                            onUpdateMinPts = viewModel::updateDbscanMinPts,
                            onToggleEpsilonRings = viewModel::toggleDbscanEpsilonRings,
                            developerModeEnabled = isDevMode
                        )

                        SessionHistoryStripCard(
                            history = uiState.sessionHistory,
                            activeRunId = uiState.activeHistoryRunId,
                            onRestoreRun = viewModel::restoreSessionRun,
                            onOpenFullHistory = { showSessionHistoryDialog = true }
                        )

                        PresetDatasetSelectorCard(
                            selectedPreset = uiState.selectedPreset,
                            sampleCount = uiState.sampleCount,
                            noiseSpread = uiState.noiseSpread,
                            onSelectPreset = { viewModel.loadPreset(it) },
                            onUpdateSampleCount = viewModel::updateSampleCount,
                            onUpdateNoiseSpread = viewModel::updateNoiseSpread,
                            developerModeEnabled = isDevMode
                        )

                        PdfReportExportCard(
                            datasetTitle = uiState.datasetTitle,
                            algorithmName = uiState.algorithm.displayName,
                            pointCount = displayPoints.size,
                            clusterCount = clusterCount,
                            silhouetteScore = silhouetteScore,
                            savedPdfCount = localPdfReports.size,
                            onQuickSaveLocalPdf = {
                                val saved = PdfReportGenerator.savePdfReportToLocalDevice(
                                    context = context,
                                    input = buildPdfReportInput(),
                                    desiredName = uiState.datasetTitle
                                )
                                localPdfReports = PdfReportGenerator.listLocalPdfReports(context)
                                viewModel.postStatusBanner(
                                    "Saved PDF report '${saved.fileName}' (${saved.formattedSize}) to local device storage."
                                )
                            },
                            onOpenPdfManager = { showPdfManagerDialog = true },
                            onExportPdfToFolder = {
                                exportPdfLauncher.launch(
                                    PdfReportGenerator.sanitizePdfFileName(uiState.datasetTitle)
                                )
                            }
                        )

                        BatchProcessingQuickCard(
                            batchState = uiState.batchState,
                            onQueueCurrentCanvas = viewModel::enqueueCurrentCanvasForBatch,
                            onOpenBatchDialog = { showBatchDialog = true },
                            onOpenCombinedPdf = { fileName ->
                                val opened = PdfReportGenerator.openLocalPdfReport(context, fileName)
                                if (!opened) {
                                    viewModel.postStatusBanner(
                                        "No PDF viewer app found to open '$fileName'. Use Share or Save instead."
                                    )
                                }
                            },
                            onShareCombinedPdf = { fileName ->
                                PdfReportGenerator.shareLocalPdfReport(context, fileName)
                            }
                        )

                        if (isDevMode) {
                            MetricsInspectorCard(
                                algorithm = uiState.algorithm,
                                frame = activeFrame
                            )

                            LocalCsvStorageCard(
                                datasetTitle = uiState.datasetTitle,
                                pointCount = displayPoints.size,
                                savedCsvCount = localCsvFiles.size,
                                onQuickSaveLocalCsv = {
                                    val info = LocalCsvFileManager.saveCsvToLocalDevice(
                                        context = context,
                                        desiredName = uiState.datasetTitle,
                                        points = displayPoints,
                                        centroids = displayCentroids
                                    )
                                    localCsvFiles = LocalCsvFileManager.listLocalCsvFiles(context)
                                    viewModel.postStatusBanner(
                                        "Saved '${info.fileName}' (${info.pointCount} pts, ${info.formattedSize}) to local device storage."
                                    )
                                },
                                onOpenCsvManager = { showCsvManagerDialog = true },
                                onExportCsvToSystemStorage = {
                                    exportCsvLauncher.launch(
                                        LocalCsvFileManager.sanitizeFileName(uiState.datasetTitle)
                                    )
                                },
                                onShareCsvDataset = {
                                    LocalCsvFileManager.shareCsvDatasetText(
                                        context = context,
                                        datasetTitle = uiState.datasetTitle,
                                        csvContent = viewModel.exportCurrentPointsCsv()
                                    )
                                }
                            )
                        }

                        Spacer(modifier = Modifier.height(20.dp))
                    }
                }
            }
        }
    }

    if (showCsvManagerDialog) {
        CsvStorageManagerDialog(
            datasetTitle = uiState.datasetTitle,
            csvPreviewText = viewModel.exportCurrentPointsCsv(),
            localCsvFiles = localCsvFiles,
            onDismiss = { showCsvManagerDialog = false },
            onSaveToLocalDevice = { fileName ->
                val info = LocalCsvFileManager.saveCsvToLocalDevice(
                    context = context,
                    desiredName = fileName,
                    points = displayPoints,
                    centroids = displayCentroids
                )
                localCsvFiles = LocalCsvFileManager.listLocalCsvFiles(context)
                viewModel.postStatusBanner(
                    "Saved '${info.fileName}' (${info.pointCount} pts) to local device storage."
                )
            },
            onImportFromLocalDevice = { fileName ->
                val rawCsv = LocalCsvFileManager.readLocalCsvText(context, fileName)
                if (rawCsv != null) {
                    viewModel.importRawTextData(rawCsv, fileName.removeSuffix(".csv"))
                    showCsvManagerDialog = false
                }
            },
            onDeleteLocalCsv = { fileName ->
                LocalCsvFileManager.deleteLocalCsvFile(context, fileName)
                localCsvFiles = LocalCsvFileManager.listLocalCsvFiles(context)
            },
            onShareLocalCsv = { fileName ->
                val rawCsv = LocalCsvFileManager.readLocalCsvText(context, fileName)
                if (rawCsv != null) {
                    LocalCsvFileManager.shareCsvDatasetText(
                        context = context,
                        datasetTitle = fileName,
                        csvContent = rawCsv
                    )
                }
            },
            onBrowseSystemStorageImport = {
                showCsvManagerDialog = false
                importFileLauncher.launch(
                    arrayOf("text/csv", "text/comma-separated-values", "application/json", "text/plain", "*/*")
                )
            },
            onExportToSystemStorage = { fileName ->
                showCsvManagerDialog = false
                exportCsvLauncher.launch(LocalCsvFileManager.sanitizeFileName(fileName))
            }
        )
    }

    if (showSaveDialog) {
        SaveSnapshotDialog(
            initialTitle = uiState.datasetTitle,
            onDismiss = { showSaveDialog = false },
            onConfirmSave = { title ->
                viewModel.saveCurrentSnapshot(title)
                showSaveDialog = false
            }
        )
    }

    if (showSavedListDialog) {
        SavedSnapshotsDialog(
            savedDatasets = savedDatasets,
            onDismiss = { showSavedListDialog = false },
            onLoadSnapshot = { entity ->
                viewModel.loadSavedSnapshot(entity)
            },
            onDeleteSnapshot = { id ->
                viewModel.deleteSavedSnapshot(id)
            }
        )
    }

    if (showPasteDialog) {
        PasteDatasetDialog(
            onDismiss = { showPasteDialog = false },
            onParseAndLoad = { rawText, label ->
                viewModel.importRawTextData(rawText, label)
            }
        )
    }

    if (showPdfManagerDialog) {
        PdfReportManagerDialog(
            datasetTitle = uiState.datasetTitle,
            algorithmSummary = uiState.algorithm.displayName,
            pointCount = displayPoints.size,
            clusterCount = clusterCount,
            localPdfReports = localPdfReports,
            onDismiss = { showPdfManagerDialog = false },
            onSaveToLocalDevice = { fileName ->
                val saved = PdfReportGenerator.savePdfReportToLocalDevice(
                    context = context,
                    input = buildPdfReportInput(),
                    desiredName = fileName
                )
                localPdfReports = PdfReportGenerator.listLocalPdfReports(context)
                viewModel.postStatusBanner(
                    "Saved PDF report '${saved.fileName}' (${saved.formattedSize}) to local device storage."
                )
            },
            onExportToFolder = { fileName ->
                showPdfManagerDialog = false
                exportPdfLauncher.launch(PdfReportGenerator.sanitizePdfFileName(fileName))
            },
            onOpenLocalPdf = { fileName ->
                val opened = PdfReportGenerator.openLocalPdfReport(context, fileName)
                if (!opened) {
                    viewModel.postStatusBanner(
                        "No PDF viewer app found to open '$fileName'. Use Share or Save to Folder instead."
                    )
                }
            },
            onShareLocalPdf = { fileName ->
                val shared = PdfReportGenerator.shareLocalPdfReport(context, fileName)
                if (!shared) {
                    viewModel.postStatusBanner("Could not share '$fileName'.")
                }
            },
            onDeleteLocalPdf = { fileName ->
                PdfReportGenerator.deleteLocalPdfReport(context, fileName)
                localPdfReports = PdfReportGenerator.listLocalPdfReports(context)
            }
        )
    }

    if (showSettingsDialog) {
        SettingsMenuDialog(
            isDarkTheme = uiState.isDarkTheme,
            showGrid = uiState.showGrid,
            showSpiderLines = uiState.showSpiderLines,
            developerModeEnabled = uiState.developerModeEnabled,
            onSetDarkTheme = { darkEnabled ->
                viewModel.setDarkTheme(darkEnabled)
                viewModel.postStatusBanner(
                    if (darkEnabled) {
                        "Switched to Dark Studio mode (saved)."
                    } else {
                        "Switched to Light Studio mode (saved)."
                    }
                )
            },
            onSetShowGrid = viewModel::setShowGrid,
            onSetShowSpiderLines = viewModel::setShowSpiderLines,
            onSetDeveloperMode = { enabled ->
                viewModel.setDeveloperMode(enabled)
                viewModel.postStatusBanner(
                    if (enabled) {
                        "Developer Mode enabled — advanced controls unlocked."
                    } else {
                        "Developer Mode hidden — simplified view restored."
                    }
                )
            },
            onOpenUserGuide = {
                showSettingsDialog = false
                showUserGuideDialog = true
            },
            onDismiss = { showSettingsDialog = false }
        )
    }

    if (showSessionHistoryDialog) {
        SessionHistoryDialog(
            history = uiState.sessionHistory,
            activeRunId = uiState.activeHistoryRunId,
            onRestoreRun = viewModel::restoreSessionRun,
            onClearHistory = viewModel::clearSessionHistory,
            onDismiss = { showSessionHistoryDialog = false }
        )
    }

    if (showBatchDialog) {
        BatchProcessingDialog(
            batchState = uiState.batchState,
            savedDatasets = savedDatasets,
            onQueueCurrentCanvas = viewModel::enqueueCurrentCanvasForBatch,
            onQueuePreset = { preset -> viewModel.enqueuePresetForBatch(preset) },
            onQueueSavedSnapshot = viewModel::enqueueSavedSnapshotForBatch,
            onQueueBenchmarkSuite = viewModel::enqueueStandardBenchmarkSuite,
            onRemoveQueueItem = viewModel::removeBatchQueueItem,
            onClearQueue = viewModel::clearBatchQueue,
            onRunBatchAndGeneratePdf = { reportName ->
                viewModel.launchBatchProcessing(
                    context = context,
                    batchName = reportName,
                    onCombinedPdfSaved = {
                        localPdfReports = PdfReportGenerator.listLocalPdfReports(context)
                    }
                )
            },
            onLoadResultToCanvas = viewModel::loadBatchResultToCanvas,
            onOpenCombinedPdf = { fileName ->
                val opened = PdfReportGenerator.openLocalPdfReport(context, fileName)
                if (!opened) {
                    viewModel.postStatusBanner(
                        "No PDF viewer app found to open '$fileName'. Use Share or Save instead."
                    )
                }
            },
            onShareCombinedPdf = { fileName ->
                val shared = PdfReportGenerator.shareLocalPdfReport(context, fileName)
                if (!shared) {
                    viewModel.postStatusBanner("Could not share '$fileName'.")
                }
            },
            onExportCombinedPdfToFolder = { reportName ->
                pendingBatchExportTitle = reportName
                exportBatchPdfLauncher.launch(PdfReportGenerator.sanitizePdfFileName(reportName))
            },
            onDismiss = { showBatchDialog = false }
        )
    }

    if (showUserGuideDialog) {
        UserGuideDialog(
            onDismiss = { showUserGuideDialog = false },
            onReplayInteractiveTour = {
                showUserGuideDialog = false
                showHardenedRpcDashboard = false
                viewModel.replayCoachMarkTour()
            }
        )
    }

    pendingAnnotationTarget?.let { target ->
        ClusterAnnotationDialog(
            clusterId = target.clusterId,
            worldX = target.x,
            worldY = target.y,
            existingAnnotation = target.existingAnnotation,
            onDismiss = { pendingAnnotationTarget = null },
            onSave = { noteText ->
                viewModel.addOrUpdateClusterAnnotation(
                    clusterId = target.clusterId,
                    x = target.x,
                    y = target.y,
                    text = noteText,
                    existingId = target.existingAnnotation?.id
                )
                pendingAnnotationTarget = null
            },
            onDelete = target.existingAnnotation?.let { existing ->
                {
                    viewModel.deleteClusterAnnotation(existing.id)
                    pendingAnnotationTarget = null
                }
            }
        )
    }

    // First-launch interactive Coach-Mark Spotlight Overlay (Canvas -> Gesture Controls -> Run Button)
    InteractiveCoachMarkOverlay(
        visible = uiState.showCoachMarkTour && !showHardenedRpcDashboard,
        targets = coachTargets,
        onInteractiveDropSamplePoint = {
            viewModel.addPointAt(0.52f, 0.48f)
            viewModel.postStatusBanner("Nice! Point added — centroids & quality score updated live.")
        },
        onInteractiveRunClustering = {
            viewModel.runClusteringAnimationFromStart()
            viewModel.postStatusBanner("Running clustering animation from start to convergence!")
        },
        onComplete = viewModel::completeCoachMarkTour,
        onSkip = viewModel::completeCoachMarkTour
    )
    }
}
