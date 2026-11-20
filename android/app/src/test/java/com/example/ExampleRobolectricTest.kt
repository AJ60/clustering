package com.example

import android.content.ComponentCallbacks2
import android.content.Context
import android.content.Intent
import androidx.test.core.app.ApplicationProvider
import com.example.domain.ClusteringEngine
import com.example.domain.DatasetGenerator
import com.example.model.DbscanConfig
import com.example.model.KMeansConfig
import com.example.model.PresetDatasetType
import com.example.service.HardwareProbe
import com.example.service.RpcService
import com.example.service.WorkerRunState
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlinx.coroutines.flow.first
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29, 36])
class ExampleRobolectricTest {

    @Test
    fun `verify app name and 50 percent physical ram cap across old and new android`() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        assertEquals("ClusterLab", context.getString(R.string.app_name))

        val mem = HardwareProbe.readProcMemInfo()
        assertTrue("Total physical RAM must be positive", mem.totalMb > 0)
        assertTrue(
            "Safe cap (${mem.safeCapMb} MB) must never exceed 50% of MemTotal (${mem.totalMb / 2} MB)",
            mem.safeCapMb <= (mem.totalMb / 2)
        )
    }

    @Test
    fun `verify RpcService 32-byte GGUF v9 handshake and onTrimMemory SHED_LAYERS guard`() {
        val controller = Robolectric.buildService(RpcService::class.java).create()
        val service = controller.get()

        // Verify 32-byte GGUF / RPC v9 / v1.0.0 frame encoding
        val frame = service.build32ByteGgufHandshake(safeCapMb = 1536, bigCores = 4)
        assertEquals(32, frame.size)
        val buf = ByteBuffer.wrap(frame).order(ByteOrder.LITTLE_ENDIAN)
        val magic = ByteArray(4).also { buf.get(it) }
        assertEquals("GGUF", String(magic, Charsets.US_ASCII))
        assertEquals(9, buf.int) // RPC v9
        val tag = ByteArray(8).also { buf.get(it) }
        assertTrue(String(tag, Charsets.US_ASCII).startsWith("v1.0.0"))
        assertEquals(1536, buf.int)
        assertEquals(4, buf.int)

        // Trigger TRIM_MEMORY_RUNNING_CRITICAL and verify emergency SHED_LAYERS state
        @Suppress("DEPRECATION")
        service.onTrimMemory(ComponentCallbacks2.TRIM_MEMORY_RUNNING_CRITICAL)
        val telemetry = RpcService.telemetry.value
        assertEquals(WorkerRunState.SHEDDING_MEMORY, telemetry.workerState)
        assertEquals(0, telemetry.activeLayersAssigned)

        // Verify 1-Tap Stop & Free RAM intent stops service cleanly
        val stopIntent = Intent(ApplicationProvider.getApplicationContext(), RpcService::class.java).apply {
            action = RpcService.ACTION_STOP_FREE_RAM
        }
        service.onStartCommand(stopIntent, 0, 1)
        assertEquals(WorkerRunState.STOPPED, RpcService.telemetry.value.workerState)
    }

    @Test
    fun `verify K-Means and DBSCAN engines converge on Two Moons benchmark`() {
        val points = DatasetGenerator.generate(
            type = PresetDatasetType.TWO_MOONS,
            count = 80,
            noiseSpread = 0.03f,
            seed = 123L
        )
        assertEquals(80, points.size)

        val kmeansFrames = ClusteringEngine.computeKMeansFrames(
            rawPoints = points,
            config = KMeansConfig(k = 2, useKMeansPlusPlus = true)
        )
        assertTrue(kmeansFrames.isNotEmpty())
        assertTrue(kmeansFrames.last().isConverged)
        assertEquals(2, kmeansFrames.last().centroids.size)

        val dbscanFrames = ClusteringEngine.computeDbscanFrames(
            rawPoints = points,
            config = DbscanConfig(epsilon = 0.09f, minPts = 4)
        )
        assertTrue(dbscanFrames.isNotEmpty())
        assertTrue(dbscanFrames.last().isConverged)
    }

    @Test
    fun `verify QR code pairing URI parsing and RpcService pairing intent`() {
        val parsed = RpcService.parseQrPairingPayload(
            "clusterd://pair?master=192.168.1.50:8080&rpc=50052&secret=my-cluster-key"
        )
        requireNotNull(parsed)
        assertEquals("192.168.1.50:8080", parsed.first)
        assertEquals("my-cluster-key", parsed.second)
        assertEquals(false, parsed.third)

        val controller = Robolectric.buildService(RpcService::class.java).create()
        val service = controller.get()
        val pairIntent = Intent(ApplicationProvider.getApplicationContext(), RpcService::class.java).apply {
            action = RpcService.ACTION_PAIR_QR_URI
            putExtra(
                RpcService.EXTRA_QR_URI,
                "clusterd://pair?master=10.0.0.42:8080&rpc=50052&secret=lan-secret"
            )
        }
        service.onStartCommand(pairIntent, 0, 2)
        val state = RpcService.telemetry.value
        assertEquals("10.0.0.42:8080", state.pairedMasterAddress)
        assertEquals("lan-secret", state.clusterSecret)
        assertEquals(false, state.usbLoopbackOnly)
        assertEquals("0.0.0.0:50052", state.bindAddress)

        // Verify 21x21 ClusterQrCodec encode -> decode roundtrip used by CameraX QR scanner
        val originalUri = "clusterd://pair?master=192.168.1.50:8080&rpc=50052&secret=my-cluster-key"
        val matrix = com.example.ui.components.ClusterQrCodec.encodeUriTo21x21Matrix(originalUri)
        assertEquals(21, matrix.size)
        val decodedUri = com.example.ui.components.ClusterQrCodec.decode21x21MatrixToUri(matrix)
        assertEquals(originalUri, decodedUri)
    }

    @Test
    fun `verify real-time centroid updates when tapping to add data points on canvas`() {
        val vm = com.example.ui.ClusteringViewModel(repository = null)
        vm.clearCanvas()
        assertEquals(0, vm.uiState.value.rawPoints.size)

        // Tap Point 1 at (0.20, 0.25) -> 1 centroid immediately appears at (0.20, 0.25)
        vm.addPointAt(0.20f, 0.25f)
        val stateAfterFirstTap = vm.uiState.value
        assertEquals(1, stateAfterFirstTap.rawPoints.size)
        val firstCentroids = stateAfterFirstTap.activeFrame?.centroids.orEmpty()
        assertEquals(1, firstCentroids.size)
        assertEquals(0.20f, firstCentroids.first().x, 0.001f)
        assertEquals(0.25f, firstCentroids.first().y, 0.001f)

        // Tap Point 2 at (0.80, 0.75) -> centroids immediately update in real time
        vm.addPointAt(0.80f, 0.75f)
        val stateAfterSecondTap = vm.uiState.value
        assertEquals(2, stateAfterSecondTap.rawPoints.size)
        assertEquals(1, stateAfterSecondTap.previousCentroids.size)
        assertTrue(stateAfterSecondTap.activeFrame?.centroids.orEmpty().size >= 2)
    }

    @Test
    fun `verify CSV dataset export and import round-trip using local device storage`() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val originalPoints = listOf(
            com.example.model.DataPoint(id = 1, x = 0.15f, y = 0.25f, clusterId = 0, role = com.example.model.PointRole.CORE),
            com.example.model.DataPoint(id = 2, x = 0.78f, y = 0.82f, clusterId = 1, role = com.example.model.PointRole.BORDER),
            com.example.model.DataPoint(id = 3, x = 0.50f, y = 0.45f, clusterId = -1, role = com.example.model.PointRole.NOISE)
        )
        val centroids = listOf(
            com.example.model.CentroidState(clusterId = 0, x = 0.15f, y = 0.25f),
            com.example.model.CentroidState(clusterId = 1, x = 0.78f, y = 0.82f)
        )

        val savedInfo = com.example.data.LocalCsvFileManager.saveCsvToLocalDevice(
            context = context,
            desiredName = "Test Export Config",
            points = originalPoints,
            centroids = centroids
        )
        assertEquals("Test_Export_Config.csv", savedInfo.fileName)
        assertEquals(3, savedInfo.pointCount)

        val files = com.example.data.LocalCsvFileManager.listLocalCsvFiles(context)
        assertTrue(files.any { it.fileName == "Test_Export_Config.csv" })

        val loadedPoints = com.example.data.LocalCsvFileManager.loadPointsFromLocalCsv(
            context = context,
            fileName = savedInfo.fileName
        )
        assertEquals(3, loadedPoints.size)
        assertEquals(0.15f, loadedPoints[0].x, 0.001f)
        assertEquals(0.25f, loadedPoints[0].y, 0.001f)
        assertEquals(0, loadedPoints[0].clusterId)
        assertEquals(com.example.model.PointRole.CORE, loadedPoints[0].role)
        assertEquals(0.78f, loadedPoints[1].x, 0.001f)
        assertEquals(com.example.model.PointRole.NOISE, loadedPoints[2].role)

        assertTrue(com.example.data.LocalCsvFileManager.deleteLocalCsvFile(context, savedInfo.fileName))
    }

    @Test
    fun `verify cross-OS auth token bit-exact parity with Rust clusterd and Android platform flag`() {
        val secret = "mixed-cluster-secret"
        val token = RpcService.computeClusterAuthToken(secret)
        assertEquals(32, token.size)

        val actualHex = token.joinToString("") { "%02x".format(it.toInt() and 0xFF) }
        // Exact 32-byte vector computed by Rust clusterd/src/protocol.rs & scripts/verify_mixed_cluster.py
        assertEquals(
            "3d833281570ea363b317df42465890a233b8b96999acb1d762ad8f0ca631a007",
            actualHex
        )
        assertTrue(RpcService.verifyClusterAuthToken(secret, token))
        assertTrue(!RpcService.verifyClusterAuthToken("wrong-secret", token))

        // Verify Android worker handshake sets FLAG_PLATFORM_ANDROID (bit 6 = 64) for Windows/Linux Masters
        val controller = Robolectric.buildService(RpcService::class.java).create()
        val service = controller.get()
        val frame = service.build32ByteGgufHandshake(safeCapMb = 2048, bigCores = 4)
        assertEquals(32, frame.size)
        val buf = ByteBuffer.wrap(frame).order(ByteOrder.LITTLE_ENDIAN)
        buf.position(24)
        val flags = buf.int
        assertTrue(
            "Android handshake must set FLAG_PLATFORM_ANDROID (0x40), got flags=0x${flags.toString(16)}",
            (flags and RpcService.FLAG_PLATFORM_ANDROID) != 0
        )
    }

    @Test
    fun `verify Android worker auto-calibration, auto-diagnosis, and Developer Mode default off`() {
        val context = ApplicationProvider.getApplicationContext<Context>()

        // Developer Mode must be OFF by default so beginners see only the simplified UI
        RpcService.setDeveloperMode(false)
        assertEquals(false, RpcService.telemetry.value.developerModeEnabled)

        // Auto-Calibration runs benchmark and locks safe RAM <= 50% physical RAM + optimal threads
        val profile = RpcService.runAutoCalibration(context)
        assertTrue("Calibration must complete", profile.isCalibrated)
        assertTrue("Score must be normalized 15..100", profile.performanceScore in 15..100)
        assertTrue("Recommended threads must be >= 1", profile.recommendedThreads >= 1)
        assertTrue(
            "Calibrated safe RAM must stay <= 50% of physical RAM",
            profile.recommendedSafeRamMb <= (RpcService.telemetry.value.totalRamMb / 2L)
        )
        assertTrue(profile.tierLabel.isNotBlank())

        // Auto-Diagnosis runs all 6 plain-English health checks and produces actionable tips
        val report = RpcService.runAutoDiagnostics(context)
        assertTrue("Diagnosis must produce plain-English headline", report.headline.isNotBlank())
        assertEquals(6, report.checks.size)
        assertTrue(report.checks.any { it.id == "calibration" && it.severity == com.example.service.DiagnosticSeverity.OK })
        assertTrue(report.checks.any { it.id == "master_reachability" })
        assertTrue(report.checks.any { it.id == "battery_thermal" })

        // Toggling Developer Mode reveals advanced settings on demand
        RpcService.setDeveloperMode(true)
        assertEquals(true, RpcService.telemetry.value.developerModeEnabled)
        RpcService.setDeveloperMode(false)
        assertEquals(false, RpcService.telemetry.value.developerModeEnabled)
    }

    @Test
    fun `verify PDF report summary generation with visualization snapshot and key statistics saved to local storage`() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val points = DatasetGenerator.generate(
            type = PresetDatasetType.GAUSSIAN_BLOBS,
            count = 60,
            noiseSpread = 0.04f,
            seed = 77L
        )
        val kMeansConfig = KMeansConfig(k = 3, useKMeansPlusPlus = true)
        val kMeansFrame = ClusteringEngine.computeKMeansFrames(points, kMeansConfig).last()

        val kMeansInput = com.example.data.PdfReportInput(
            datasetTitle = "Gaussian Blobs Benchmark",
            algorithm = com.example.model.AlgorithmType.KMEANS,
            kMeansConfig = kMeansConfig,
            dbscanConfig = DbscanConfig(),
            points = kMeansFrame.points,
            centroids = kMeansFrame.centroids,
            frame = kMeansFrame
        )

        val savedKMeans = com.example.data.PdfReportGenerator.savePdfReportToLocalDevice(
            context = context,
            input = kMeansInput,
            desiredName = "Gaussian Blobs Benchmark"
        )
        assertEquals("Gaussian_Blobs_Benchmark_report.pdf", savedKMeans.fileName)
        assertTrue("Saved PDF must be non-empty (> 200 bytes), got ${savedKMeans.sizeBytes}", savedKMeans.sizeBytes > 200L)

        val savedFile = java.io.File(savedKMeans.absolutePath)
        assertTrue("PDF file must exist on local device storage", savedFile.exists())
        val rawBytes = savedFile.readBytes()
        val rawText = String(rawBytes, Charsets.ISO_8859_1)
        assertTrue("PDF must start with %PDF- header", rawText.startsWith("%PDF-"))
        assertTrue("PDF must terminate with %%EOF marker", rawText.trimEnd().endsWith("%%EOF"))

        // Also test DBSCAN summary report generation + local directory listing
        val dbscanConfig = DbscanConfig(epsilon = 0.09f, minPts = 4)
        val dbscanFrame = ClusteringEngine.computeDbscanFrames(points, dbscanConfig).last()
        val dbscanInput = com.example.data.PdfReportInput(
            datasetTitle = "Density Scan",
            algorithm = com.example.model.AlgorithmType.DBSCAN,
            kMeansConfig = kMeansConfig,
            dbscanConfig = dbscanConfig,
            points = dbscanFrame.points,
            centroids = dbscanFrame.centroids,
            frame = dbscanFrame
        )
        val savedDbscan = com.example.data.PdfReportGenerator.savePdfReportToLocalDevice(
            context = context,
            input = dbscanInput,
            desiredName = "Density Scan"
        )
        assertTrue("DBSCAN PDF must be non-empty", savedDbscan.sizeBytes > 200L)

        val listed = com.example.data.PdfReportGenerator.listLocalPdfReports(context)
        assertTrue(listed.any { it.fileName == savedKMeans.fileName })
        assertTrue(listed.any { it.fileName == savedDbscan.fileName })

        // Clean up local PDF files
        assertTrue(com.example.data.PdfReportGenerator.deleteLocalPdfReport(context, savedKMeans.fileName))
        assertTrue(com.example.data.PdfReportGenerator.deleteLocalPdfReport(context, savedDbscan.fileName))
        val afterDelete = com.example.data.PdfReportGenerator.listLocalPdfReports(context)
        assertTrue(afterDelete.none { it.fileName == savedKMeans.fileName })
        assertTrue(afterDelete.none { it.fileName == savedDbscan.fileName })
    }

    @Test
    fun `verify dark and light mode preference persists using DataStore`() = kotlinx.coroutines.test.runTest {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val testFile = java.io.File(
            context.filesDir,
            "test_theme_prefs_${System.nanoTime()}.preferences_pb"
        )
        try {
            val dataStore = androidx.datastore.preferences.core.PreferenceDataStoreFactory.create(
                scope = backgroundScope,
                produceFile = { testFile }
            )
            val repo = com.example.data.ThemePreferencesRepository(dataStore)

            // Default is Dark mode (reduces eye strain during long sessions) & Developer Mode OFF
            val initialPrefs = repo.preferencesFlow.first()
            assertEquals(true, initialPrefs.isDarkTheme)
            assertEquals(true, initialPrefs.showGrid)
            assertEquals(true, initialPrefs.showSpiderLines)
            assertEquals(false, initialPrefs.developerModeEnabled)

            // Toggle to Light mode, update canvas comfort preferences, and enable Developer Mode
            repo.setDarkTheme(false)
            repo.setShowGrid(false)
            repo.setShowSpiderLines(false)
            repo.setDeveloperMode(true)

            val updatedPrefs = repo.preferencesFlow.first()
            assertEquals(false, updatedPrefs.isDarkTheme)
            assertEquals(false, updatedPrefs.showGrid)
            assertEquals(false, updatedPrefs.showSpiderLines)
            assertEquals(true, updatedPrefs.developerModeEnabled)

            // Re-read through a fresh repository wrapper over the same DataStore to verify persistence
            val repoReloaded = com.example.data.ThemePreferencesRepository(dataStore)
            assertEquals(false, repoReloaded.isDarkThemeFlow.first())
            assertEquals(true, repoReloaded.developerModeFlow.first())

            // Toggle back to Dark mode and hide Developer Mode again
            repoReloaded.setDarkTheme(true)
            repoReloaded.setDeveloperMode(false)
            assertEquals(true, repo.isDarkThemeFlow.first())
            assertEquals(false, repo.developerModeFlow.first())
        } finally {
            testFile.delete()
        }
    }

    @Test
    fun `verify real-time canvas Silhouette and Inertia scores update and Developer Mode defaults off`() {
        val vm = com.example.ui.ClusteringViewModel(repository = null)
        // Advanced settings must be hidden until toggled on
        assertEquals(false, vm.uiState.value.developerModeEnabled)

        // Default preset computes real-time Silhouette and Inertia (WCSS) for the canvas overlay
        val initialFrame = requireNotNull(vm.uiState.value.activeFrame)
        assertTrue("Initial inertia (WCSS) must be positive", initialFrame.wcss > 0f)
        assertTrue(
            "Initial silhouette must be in [-1, 1]",
            initialFrame.silhouetteScore in -1f..1f
        )

        // Changing K updates inertia immediately for real-time evaluation
        vm.updateKMeansK(5)
        val afterK5 = requireNotNull(vm.uiState.value.activeFrame)
        assertTrue("Inertia with K=5 should be finite and >= 0", afterK5.wcss >= 0f)
        assertTrue("Silhouette with K=5 must stay in [-1, 1]", afterK5.silhouetteScore in -1f..1f)

        // Toggling Developer Mode syncs both ClusteringViewModel and RpcService
        vm.setDeveloperMode(true)
        assertEquals(true, vm.uiState.value.developerModeEnabled)
        assertEquals(true, RpcService.telemetry.value.developerModeEnabled)

        vm.setDeveloperMode(false)
        assertEquals(false, vm.uiState.value.developerModeEnabled)
        assertEquals(false, RpcService.telemetry.value.developerModeEnabled)
    }

    @Test
    fun `verify first-launch coach-mark onboarding persists in DataStore and supports replay`() =
        kotlinx.coroutines.test.runTest {
            val context = ApplicationProvider.getApplicationContext<Context>()
            val testFile = java.io.File(
                context.filesDir,
                "test_onboarding_prefs_${System.nanoTime()}.preferences_pb"
            )
            try {
                val dataStore = androidx.datastore.preferences.core.PreferenceDataStoreFactory.create(
                    scope = backgroundScope,
                    produceFile = { testFile }
                )
                val repo = com.example.data.ThemePreferencesRepository(dataStore)

                // On first launch, onboarding has not been completed yet
                assertEquals(false, repo.hasCompletedOnboardingFlow.first())

                // Completing onboarding persists true across repository reloads
                repo.setHasCompletedOnboarding(true)
                assertEquals(true, repo.hasCompletedOnboardingFlow.first())
                val repoReloaded = com.example.data.ThemePreferencesRepository(dataStore)
                assertEquals(true, repoReloaded.hasCompletedOnboardingFlow.first())

                // ViewModel supports replaying and completing the interactive Coach-Mark tour
                val vm = com.example.ui.ClusteringViewModel(repository = null)
                assertEquals(false, vm.uiState.value.showCoachMarkTour)
                vm.replayCoachMarkTour()
                assertEquals(true, vm.uiState.value.showCoachMarkTour)
                vm.completeCoachMarkTour()
                assertEquals(false, vm.uiState.value.showCoachMarkTour)
            } finally {
                testFile.delete()
            }
        }

    @Test
    fun `verify Session History tracks last 10 clustering runs with inertia scores and restores previous states`() {
        val vm = com.example.ui.ClusteringViewModel(repository = null)

        // Initial preset load records Run #1
        assertEquals(1, vm.uiState.value.sessionHistory.size)
        assertEquals(vm.uiState.value.sessionHistory.first().runId, vm.uiState.value.activeHistoryRunId)

        // Execute 12 additional distinct clustering runs (13 total -> capped at last 10)
        for (k in 3..9) {
            vm.updateKMeansK(k)
        }
        vm.selectAlgorithm(com.example.model.AlgorithmType.DBSCAN)
        vm.updateDbscanEpsilon(0.11f)
        vm.updateDbscanMinPts(6)
        vm.selectAlgorithm(com.example.model.AlgorithmType.KMEANS)
        vm.loadPreset(PresetDatasetType.GAUSSIAN_BLOBS, jumpToConverged = true)

        val history = vm.uiState.value.sessionHistory
        assertEquals(
            "Session History must retain strictly the last 10 runs",
            com.example.ui.ClusteringViewModel.MAX_SESSION_HISTORY,
            history.size
        )

        // Verify newest-first ordering and valid inertia / frames on every recorded run
        for (i in 0 until history.size - 1) {
            assertTrue(
                "History must be ordered newest-first",
                history[i].runId > history[i + 1].runId
            )
        }
        history.forEach { run ->
            assertTrue("Inertia (WCSS) must be finite and >= 0", run.inertiaWcss.isFinite() && run.inertiaWcss >= 0f)
            assertTrue("Recorded run must preserve frames", run.frames.isNotEmpty())
            assertTrue("Recorded run must preserve raw points", run.rawPoints.isNotEmpty())
        }

        // Jump back to an earlier run (e.g., index 5) and verify full state restoration without mutating history
        val targetRun = history[5]
        vm.restoreSessionRun(targetRun.runId)

        val restoredState = vm.uiState.value
        assertEquals(targetRun.runId, restoredState.activeHistoryRunId)
        assertEquals(targetRun.algorithm, restoredState.algorithm)
        assertEquals(targetRun.datasetTitle, restoredState.datasetTitle)
        assertEquals(targetRun.kMeansConfig.k, restoredState.kMeansConfig.k)
        assertEquals(targetRun.dbscanConfig.epsilon, restoredState.dbscanConfig.epsilon, 0.0001f)
        assertEquals(targetRun.rawPoints.size, restoredState.rawPoints.size)
        assertEquals(
            targetRun.inertiaWcss,
            requireNotNull(restoredState.activeFrame).wcss,
            0.0001f
        )
        assertEquals(
            "Restoring a run must not duplicate or evict Session History entries",
            com.example.ui.ClusteringViewModel.MAX_SESSION_HISTORY,
            restoredState.sessionHistory.size
        )

        // Clear Session History
        vm.clearSessionHistory()
        assertTrue(vm.uiState.value.sessionHistory.isEmpty())
        assertEquals(null, vm.uiState.value.activeHistoryRunId)
    }

    @Test
    fun `verify batch processing queues multiple datasets sequentially and auto-generates combined multi-page PDF summary`() =
        kotlinx.coroutines.test.runTest {
            val context = ApplicationProvider.getApplicationContext<Context>()
            val vm = com.example.ui.ClusteringViewModel(repository = null)

            // Queue 3 distinct datasets with mixed algorithms (DBSCAN + K-Means + DBSCAN)
            vm.enqueueStandardBenchmarkSuite()
            assertEquals(3, vm.uiState.value.batchState.queue.size)
            assertTrue(
                "All items must start in QUEUED state",
                vm.uiState.value.batchState.queue.all { it.status == com.example.model.BatchJobStatus.QUEUED }
            )

            // Execute sequential batch processing and automatically generate the combined PDF report
            val savedPdf = vm.executeBatchQueueAndGeneratePdf(
                context = context,
                batchName = "Test_Combined_Batch"
            )
            requireNotNull(savedPdf)
            assertEquals("Test_Combined_Batch_report.pdf", savedPdf.fileName)
            assertTrue("Combined PDF must be non-empty (> 400 bytes)", savedPdf.sizeBytes > 400L)

            val finishedBatch = vm.uiState.value.batchState
            assertEquals(false, finishedBatch.isRunning)
            assertEquals(3, finishedBatch.completedCount)
            assertEquals(savedPdf.fileName, finishedBatch.lastCombinedPdfFileName)
            finishedBatch.queue.forEach { item ->
                assertEquals(com.example.model.BatchJobStatus.COMPLETED, item.status)
                val frame = requireNotNull(item.resultFrame)
                assertTrue("Each batch run must converge", frame.isConverged)
                assertTrue("Each batch run must have finite inertia", frame.wcss.isFinite() && frame.wcss >= 0f)
                assertTrue("Each batch run must have valid silhouette", frame.silhouetteScore in -1f..1f)
            }

            // Inspect the generated multi-page PDF file on local storage (1 executive summary + 3 run pages = 4 pages)
            val pdfFile = java.io.File(savedPdf.absolutePath)
            assertTrue("Combined batch PDF must exist in local storage", pdfFile.exists())
            val pdfText = String(pdfFile.readBytes(), Charsets.ISO_8859_1)
            assertTrue("Combined PDF must start with %PDF-", pdfText.startsWith("%PDF-"))
            assertTrue("Combined PDF must terminate with %%EOF", pdfText.trimEnd().endsWith("%%EOF"))
            assertTrue("Combined PDF must contain 4 pages (/Count 4)", pdfText.contains("/Count 4"))
            assertTrue("Combined PDF must reference Two Moons", pdfText.contains("Two Moons"))
            assertTrue("Combined PDF must reference Gaussian Blobs", pdfText.contains("Gaussian Blobs"))
            assertTrue("Combined PDF must reference Concentric Rings", pdfText.contains("Concentric Rings"))

            // Verify inspecting a completed batch run loads it cleanly onto the main canvas
            val secondRun = finishedBatch.queue[1]
            vm.loadBatchResultToCanvas(secondRun.jobId)
            assertEquals(secondRun.datasetTitle, vm.uiState.value.datasetTitle)
            assertEquals(secondRun.algorithm, vm.uiState.value.algorithm)

            // Verify removing an item and clearing the batch queue
            vm.removeBatchQueueItem(secondRun.jobId)
            assertEquals(2, vm.uiState.value.batchState.queue.size)
            vm.clearBatchQueue()
            assertTrue(vm.uiState.value.batchState.queue.isEmpty())

            // Clean up generated PDF artifact
            assertTrue(com.example.data.PdfReportGenerator.deleteLocalPdfReport(context, savedPdf.fileName))
        }

    @Test
    fun `verify legacy hardware and old graphics detection sets safe CPU fallback and GGUF v9 legacy flags`() {
        val context = ApplicationProvider.getApplicationContext<Context>()

        // Simulate a 2 GB RAM device with failed Vulkan probe (e.g., old Mali-400 / Adreno 4xx / GLES 2.0-3.0)
        val lowMem = HardwareProbe.MemInfoResult(totalMb = 2048L, availableMb = 900L, safeCapMb = 644L)
        val noVulkan = HardwareProbe.VulkanProbeResult(supported = false, reason = "Legacy GPU fallback")
        val legacyProfile = HardwareProbe.detectLegacyHardwareProfile(
            context = context,
            memInfo = lowMem,
            vkInfo = noVulkan
        )

        assertTrue("<= 3 GB RAM device must activate legacyHardwareMode", legacyProfile.legacyHardwareMode)
        assertTrue("Missing Vulkan + legacy device must activate legacyGraphicsMode", legacyProfile.legacyGraphicsMode)
        assertTrue("Graphics tier label must explain legacy-safe mode", legacyProfile.graphicsTierLabel.contains("Legacy-Safe"))

        // Refresh telemetry on Robolectric host (API 29 & 36 both lack physical /system/lib64/libvulkan.so)
        RpcService.refreshStaticHardwareSnapshot(context)
        val snap = RpcService.telemetry.value
        assertTrue("Host without Vulkan must enable legacyGraphicsMode safely", snap.legacyGraphicsMode)
        assertEquals(com.example.service.ComputeBackend.ARM_V8_0_NEON, snap.activeBackend)

        // Verify 32-byte GGUF v9 handshake includes FLAG_LEGACY_GRAPHICS (bit 9 = 512) and clears Vulkan FP16
        val controller = Robolectric.buildService(RpcService::class.java).create()
        val service = controller.get()
        val frame = service.build32ByteGgufHandshake(safeCapMb = 768, bigCores = 2)
        val buf = ByteBuffer.wrap(frame).order(ByteOrder.LITTLE_ENDIAN)
        buf.position(24)
        val flags = buf.int
        assertTrue("Android flag must be set", (flags and RpcService.FLAG_PLATFORM_ANDROID) != 0)
        assertTrue("Legacy graphics flag must be set", (flags and RpcService.FLAG_LEGACY_GRAPHICS) != 0)
        assertEquals("Vulkan FP16 flag must be disabled in legacy graphics mode", 0, flags and RpcService.FLAG_VULKAN_FP16)
    }

    @Test
    fun `verify K-Means smooth centroid interpolation and iteration transition tracking`() {
        val prev = listOf(
            com.example.model.CentroidState(clusterId = 0, x = 0.20f, y = 0.20f),
            com.example.model.CentroidState(clusterId = 1, x = 0.80f, y = 0.80f)
        )
        val next = listOf(
            com.example.model.CentroidState(clusterId = 0, x = 0.40f, y = 0.60f),
            com.example.model.CentroidState(clusterId = 1, x = 0.60f, y = 0.40f)
        )

        // Verify start (t=0), midpoint (t=0.5), and settled (t=1) interpolated centroid coordinates
        val atStart = com.example.ui.components.CentroidInterpolator.interpolate(prev, next, 0f)
        assertEquals(0.20f, atStart[0].x, 0.0001f)
        assertEquals(0.20f, atStart[0].y, 0.0001f)

        val atMid = com.example.ui.components.CentroidInterpolator.interpolate(prev, next, 0.5f)
        assertEquals(0.30f, atMid[0].x, 0.0001f)
        assertEquals(0.40f, atMid[0].y, 0.0001f)
        assertEquals(0.70f, atMid[1].x, 0.0001f)
        assertEquals(0.60f, atMid[1].y, 0.0001f)

        val atEnd = com.example.ui.components.CentroidInterpolator.interpolate(prev, next, 1f)
        assertEquals(0.40f, atEnd[0].x, 0.0001f)
        assertEquals(0.60f, atEnd[0].y, 0.0001f)

        val shift = com.example.ui.components.CentroidInterpolator.computeTotalShift(prev, next)
        assertTrue("Total centroid displacement must be positive", shift > 0.8f)

        // Verify ViewModel captures departing iteration centroids into previousCentroids when stepping K-Means
        val vm = com.example.ui.ClusteringViewModel(repository = null)
        vm.selectAlgorithm(com.example.model.AlgorithmType.KMEANS)
        vm.updateKMeansK(4)
        vm.resetToStart()
        val iter0State = vm.uiState.value
        assertEquals(0, iter0State.currentFrameIndex)
        assertTrue("Resetting to iteration 0 clears previousCentroids", iter0State.previousCentroids.isEmpty())

        if (iter0State.frames.size > 1) {
            val iter0Centroids = requireNotNull(iter0State.activeFrame).centroids
            val nonceBefore = iter0State.centroidTransitionNonce

            vm.stepForward()
            val iter1State = vm.uiState.value
            assertEquals(1, iter1State.currentFrameIndex)
            assertEquals(iter0Centroids, iter1State.previousCentroids)
            assertTrue("Transition nonce must advance on stepForward", iter1State.centroidTransitionNonce > nonceBefore)

            // Converging immediately from iter 1 captures iter 1's centroids for a smooth final glide
            val iter1Centroids = requireNotNull(iter1State.activeFrame).centroids
            vm.convergeImmediately()
            val convergedState = vm.uiState.value
            assertEquals(convergedState.frames.lastIndex, convergedState.currentFrameIndex)
            if (convergedState.frames.lastIndex > 1) {
                assertEquals(iter1Centroids, convergedState.previousCentroids)
            }

            // Wrapping past the final iteration back to 0 clears previousCentroids cleanly
            vm.stepForward()
            val wrappedState = vm.uiState.value
            assertEquals(0, wrappedState.currentFrameIndex)
            assertTrue("Wrapping back to iteration 0 clears previousCentroids", wrappedState.previousCentroids.isEmpty())
        }
    }

    @Test
    fun `verify long-press cluster area hit detection, annotation CRUD, session history preservation, and PDF report inclusion`() {
        val context = ApplicationProvider.getApplicationContext<Context>()

        // 1. Verify K-Means Voronoi region hit-detection & DBSCAN point-area hit-detection
        val centroids = listOf(
            com.example.model.CentroidState(clusterId = 0, x = 0.22f, y = 0.25f),
            com.example.model.CentroidState(clusterId = 1, x = 0.78f, y = 0.75f)
        )
        val clusteredPoints = listOf(
            com.example.model.DataPoint(id = 1, x = 0.20f, y = 0.24f, clusterId = 0),
            com.example.model.DataPoint(id = 2, x = 0.79f, y = 0.76f, clusterId = 1),
            com.example.model.DataPoint(id = 3, x = 0.50f, y = 0.50f, clusterId = -1, role = com.example.model.PointRole.NOISE)
        )
        assertEquals(
            0,
            com.example.ui.components.ClusterAreaHitDetector.findClusterAt(
                worldX = 0.28f,
                worldY = 0.30f,
                algorithm = com.example.model.AlgorithmType.KMEANS,
                points = clusteredPoints,
                centroids = centroids
            )
        )
        assertEquals(
            1,
            com.example.ui.components.ClusterAreaHitDetector.findClusterAt(
                worldX = 0.72f,
                worldY = 0.70f,
                algorithm = com.example.model.AlgorithmType.KMEANS,
                points = clusteredPoints,
                centroids = centroids
            )
        )
        assertEquals(
            1,
            com.example.ui.components.ClusterAreaHitDetector.findClusterAt(
                worldX = 0.80f,
                worldY = 0.77f,
                algorithm = com.example.model.AlgorithmType.DBSCAN,
                points = clusteredPoints,
                centroids = emptyList()
            )
        )
        assertEquals(
            -1,
            com.example.ui.components.ClusterAreaHitDetector.findClusterAt(
                worldX = 0.50f,
                worldY = 0.50f,
                algorithm = com.example.model.AlgorithmType.DBSCAN,
                points = clusteredPoints,
                centroids = emptyList()
            )
        )

        // 2. Verify ViewModel add, edit, hit-detect existing, Session History restore, and delete
        val vm = com.example.ui.ClusteringViewModel(repository = null)
        val firstRunId = requireNotNull(vm.uiState.value.activeHistoryRunId)

        val created = vm.addOrUpdateClusterAnnotation(
            clusterId = 0,
            x = 0.24f,
            y = 0.28f,
            text = "High-density primary cluster"
        )
        requireNotNull(created)
        assertEquals(1, vm.uiState.value.annotations.size)

        val hitExisting = com.example.ui.components.ClusterAreaHitDetector.findExistingAnnotationAt(
            worldX = 0.25f,
            worldY = 0.29f,
            annotations = vm.uiState.value.annotations
        )
        assertEquals(created.id, hitExisting?.id)

        val updated = vm.addOrUpdateClusterAnnotation(
            clusterId = 0,
            x = 0.24f,
            y = 0.28f,
            text = "Verified core customer segment",
            existingId = created.id
        )
        requireNotNull(updated)
        assertEquals(1, vm.uiState.value.annotations.size)
        assertEquals("Verified core customer segment", vm.uiState.value.annotations.first().text)

        // Load another preset (clears active canvas annotations), then jump back via Session History
        vm.loadPreset(PresetDatasetType.GAUSSIAN_BLOBS, jumpToConverged = true)
        assertTrue(vm.uiState.value.annotations.isEmpty())

        vm.restoreSessionRun(firstRunId)
        assertEquals(1, vm.uiState.value.annotations.size)
        assertEquals("Verified core customer segment", vm.uiState.value.annotations.first().text)

        // 3. Verify exported PDF summary report embeds both Section 4 heading and annotation text
        val state = vm.uiState.value
        val frame = requireNotNull(state.activeFrame)
        val pdfInput = com.example.data.PdfReportInput(
            datasetTitle = "Annotated Clusters Report",
            algorithm = state.algorithm,
            kMeansConfig = state.kMeansConfig,
            dbscanConfig = state.dbscanConfig,
            points = frame.points,
            centroids = frame.centroids,
            frame = frame,
            annotations = state.annotations
        )
        val savedPdf = com.example.data.PdfReportGenerator.savePdfReportToLocalDevice(
            context = context,
            input = pdfInput,
            desiredName = "Annotated Clusters Report"
        )
        val pdfFile = java.io.File(savedPdf.absolutePath)
        assertTrue("Annotated PDF must exist", pdfFile.exists())
        val pdfText = String(pdfFile.readBytes(), Charsets.ISO_8859_1)
        assertTrue("PDF must start with %PDF-", pdfText.startsWith("%PDF-"))
        assertTrue("PDF must include Section 4 Cluster Annotations heading", pdfText.contains("4. Cluster Annotations"))
        assertTrue("PDF must include the user's exact annotation text", pdfText.contains("Verified core customer segment"))
        assertTrue("PDF must include target cluster label", pdfText.contains("Cluster 1"))

        // Clean up generated PDF and verify annotation deletion
        assertTrue(com.example.data.PdfReportGenerator.deleteLocalPdfReport(context, savedPdf.fileName))
        vm.deleteClusterAnnotation(updated.id)
        assertTrue(vm.uiState.value.annotations.isEmpty())
    }
}



