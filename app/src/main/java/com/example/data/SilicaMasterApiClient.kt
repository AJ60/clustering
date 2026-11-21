package com.example.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.isActive
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.InetSocketAddress
import java.net.Socket
import java.net.URL
import java.nio.charset.StandardCharsets

data class MasterHealthResult(
    val reachable: Boolean,
    val latencyMs: Long = -1L,
    val activeModel: String? = null,
    val activeNodes: Int = 0,
    val detail: String = ""
)

data class RemoteClusterNodeInfo(
    val id: String,
    val label: String,
    val osType: String,
    val backendDriver: String,
    val layerStart: Int,
    val layerEnd: Int,
    val allocatedLayers: Int,
    val allocatedMb: Long,
    val estimatedTokPerSec: Float,
    val isMaster: Boolean
)

data class MasterClusterSnapshot(
    val activeModelName: String,
    val totalSafePoolMb: Long,
    val neededMb: Long,
    val fitVerdict: String,
    val estimatedClusterTokPerSec: Float,
    val nodes: List<RemoteClusterNodeInfo>
)

data class ChatCompletionMessage(
    val role: String,
    val content: String
)

/**
 * Live HTTP/SSE client communicating with any OpenAI-compatible LAN/USB Master
 * (`clusterd`, native `llama-server` on `:8080`, or companion Express bridge on `:3000`).
 */
object SilicaMasterApiClient {

    fun normalizeBaseUrl(raw: String): String {
        val trimmed = raw.trim().trimEnd('/')
        if (trimmed.isEmpty()) return "http://127.0.0.1:3000"
        val withScheme = if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
            trimmed
        } else {
            "http://$trimmed"
        }
        return if (withScheme.endsWith("/v1")) {
            withScheme.removeSuffix("/v1")
        } else {
            withScheme
        }
    }

    suspend fun probeHealth(baseUrl: String, secret: String): MasterHealthResult =
        withContext(Dispatchers.IO) {
            val normalized = normalizeBaseUrl(baseUrl)
            val start = System.currentTimeMillis()
            val altPortUrl = when {
                normalized.contains(":8080") -> normalized.replace(":8080", ":3000")
                normalized.contains(":3000") -> normalized.replace(":3000", ":8080")
                else -> "$normalized:3000"
            }
            // Auto-probe port 3000 (ClusterLab Master) and port 8080 (llama-server)
            val candidates = listOf(
                "$normalized/health",
                "$altPortUrl/health",
                "$normalized/v1/models",
                "$altPortUrl/v1/models"
            )
            for (endpoint in candidates) {
                val res = runCatching {
                    val conn = (URL(endpoint).openConnection() as HttpURLConnection).apply {
                        requestMethod = "GET"
                        connectTimeout = 2000
                        readTimeout = 2500
                        setRequestProperty("Accept", "application/json")
                        if (secret.isNotBlank()) {
                            setRequestProperty("X-Cluster-Secret", secret)
                        }
                    }
                    try {
                        val code = conn.responseCode
                        val body = (if (code in 200..299) conn.inputStream else conn.errorStream)
                            ?.bufferedReader(StandardCharsets.UTF_8)
                            ?.use { it.readText() }
                            .orEmpty()
                        code to body
                    } finally {
                        conn.disconnect()
                    }
                }.getOrNull() ?: continue

                val (code, body) = res
                if (code in 200..299) {
                    val latency = (System.currentTimeMillis() - start).coerceAtLeast(1L)
                    val json = runCatching { JSONObject(body) }.getOrNull()
                    val activeModel = json?.optString("activeModel").orEmpty().ifBlank {
                        json?.optJSONArray("data")?.optJSONObject(0)?.optString("id")
                    }
                    val activeNodes = json?.optInt("activeNodes", 0) ?: 0
                    return@withContext MasterHealthResult(
                        reachable = true,
                        latencyMs = latency,
                        activeModel = activeModel,
                        activeNodes = activeNodes,
                        detail = "Online ($latency ms)"
                    )
                }
            }
            MasterHealthResult(
                reachable = false,
                detail = "Unreachable at $normalized"
            )
        }

    suspend fun fetchModels(baseUrl: String, secret: String): List<String> =
        withContext(Dispatchers.IO) {
            val normalized = normalizeBaseUrl(baseUrl)
            runCatching {
                val conn = (URL("$normalized/v1/models").openConnection() as HttpURLConnection).apply {
                    requestMethod = "GET"
                    connectTimeout = 2500
                    readTimeout = 3000
                    setRequestProperty("Accept", "application/json")
                    if (secret.isNotBlank()) {
                        setRequestProperty("X-Cluster-Secret", secret)
                    }
                }
                try {
                    if (conn.responseCode !in 200..299) return@runCatching emptyList()
                    val text = conn.inputStream.bufferedReader(StandardCharsets.UTF_8).use { it.readText() }
                    val json = JSONObject(text)
                    val data = json.optJSONArray("data") ?: return@runCatching emptyList()
                    buildList {
                        for (i in 0 until data.length()) {
                            val id = data.optJSONObject(i)?.optString("id").orEmpty()
                            if (id.isNotBlank()) add(id)
                        }
                    }
                } finally {
                    conn.disconnect()
                }
            }.getOrDefault(emptyList())
        }

    suspend fun fetchClusterState(baseUrl: String, secret: String): MasterClusterSnapshot? =
        withContext(Dispatchers.IO) {
            val normalized = normalizeBaseUrl(baseUrl)
            val altUrl = when {
                normalized.contains(":8080") -> normalized.replace(":8080", ":3000")
                normalized.contains(":3000") -> normalized.replace(":3000", ":8080")
                else -> "$normalized:3000"
            }
            val urls = listOf("$normalized/api/cluster/state", "$altUrl/api/cluster/state")
            for (targetUrl in urls) {
                val snapshot = runCatching {
                    val conn = (URL(targetUrl).openConnection() as HttpURLConnection).apply {
                        requestMethod = "GET"
                        connectTimeout = 2500
                        readTimeout = 3000
                        setRequestProperty("Accept", "application/json")
                        if (secret.isNotBlank()) {
                            setRequestProperty("X-Cluster-Secret", secret)
                        }
                    }
                    try {
                        if (conn.responseCode !in 200..299) return@runCatching null
                        val text = conn.inputStream.bufferedReader(StandardCharsets.UTF_8).use { it.readText() }
                        val root = JSONObject(text)
                        val activeModelObj = root.optJSONObject("activeModel")
                        val modelName = activeModelObj?.optString("name").orEmpty()
                            .ifBlank { activeModelObj?.optString("id").orEmpty() }
                        val plan = root.optJSONObject("plan") ?: return@runCatching null
                        val nodesArr = plan.optJSONArray("nodes") ?: JSONArray()
                        val parsedNodes = buildList {
                            for (i in 0 until nodesArr.length()) {
                                val n = nodesArr.optJSONObject(i) ?: continue
                                add(
                                    RemoteClusterNodeInfo(
                                        id = n.optString("id", "node_$i"),
                                        label = n.optString("label", "Cluster Node ${i + 1}"),
                                        osType = n.optString("osType", "LAN"),
                                        backendDriver = n.optString("backendDriver", "CPU/RPC"),
                                        layerStart = n.optInt("layerStart", 0),
                                        layerEnd = n.optInt("layerEnd", 0),
                                        allocatedLayers = n.optInt("allocatedLayers", 0),
                                        allocatedMb = n.optLong("allocatedMb", 0L),
                                        estimatedTokPerSec = n.optDouble("estimatedTokPerSec", 0.0).toFloat(),
                                        isMaster = n.optBoolean("isMaster", i == 0)
                                    )
                                )
                            }
                        }
                        MasterClusterSnapshot(
                            activeModelName = modelName,
                            totalSafePoolMb = plan.optLong("totalSafePoolMb", 0L),
                            neededMb = plan.optLong("neededMb", 0L),
                            fitVerdict = plan.optString("fitVerdict", "READY"),
                            estimatedClusterTokPerSec = plan.optDouble("estimatedClusterTokPerSec", 0.0).toFloat(),
                            nodes = parsedNodes
                        )
                    } finally {
                        conn.disconnect()
                    }
                }.getOrNull()

                if (snapshot != null) return@withContext snapshot
            }
            null
        }

    suspend fun probePeerTcp(address: String, timeoutMs: Int = 900): Long? =
        withContext(Dispatchers.IO) {
            val host = address.substringBefore(":").trim()
            val port = address.substringAfter(":", "50052").toIntOrNull() ?: 50052
            if (host.isBlank() || port !in 1..65535) return@withContext null
            val start = System.currentTimeMillis()
            runCatching {
                Socket().use { sock ->
                    sock.connect(InetSocketAddress(host, port), timeoutMs)
                    (System.currentTimeMillis() - start).coerceAtLeast(1L)
                }
            }.getOrNull()
        }

    /**
     * Streams tokens from POST `<baseUrl>/v1/chat/completions` (OpenAI SSE stream with graceful
     * fallback to standard JSON completion if the upstream server replies non-streamed).
     */
    suspend fun streamChatCompletion(
        baseUrl: String,
        modelId: String,
        messages: List<ChatCompletionMessage>,
        temperature: Float,
        systemPrompt: String,
        secret: String,
        onDelta: suspend (accumulatedText: String, tokenEstimate: Int, tokPerSec: Float) -> Unit
    ): Result<Triple<String, Float, Long>> = withContext(Dispatchers.IO) {
        val normalized = normalizeBaseUrl(baseUrl)
        val startMs = System.currentTimeMillis()
        var conn: HttpURLConnection? = null

        try {
            val url = URL("$normalized/v1/chat/completions")
            conn = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 5000
                readTimeout = 45000
                doOutput = true
                setRequestProperty("Content-Type", "application/json")
                setRequestProperty("Accept", "text/event-stream, application/json")
                if (secret.isNotBlank()) {
                    setRequestProperty("X-Cluster-Secret", secret)
                    setRequestProperty("Authorization", "Bearer $secret")
                }
            }

            val msgArray = JSONArray()
            if (systemPrompt.isNotBlank()) {
                msgArray.put(JSONObject().apply {
                    put("role", "system")
                    put("content", systemPrompt)
                })
            }
            messages.forEach { msg ->
                msgArray.put(JSONObject().apply {
                    put("role", msg.role)
                    put("content", msg.content)
                })
            }

            val payload = JSONObject().apply {
                put("model", modelId)
                put("stream", true)
                put("temperature", temperature.toDouble())
                put("messages", msgArray)
            }

            conn.outputStream.use { os ->
                os.write(payload.toString().toByteArray(StandardCharsets.UTF_8))
                os.flush()
            }

            val code = conn.responseCode
            if (code !in 200..299) {
                val errBody = conn.errorStream?.bufferedReader(StandardCharsets.UTF_8)?.use { it.readText() }.orEmpty()
                return@withContext Result.failure(
                    IllegalStateException("Master HTTP $code: ${errBody.take(180).ifBlank { "Request failed" }}")
                )
            }

            val contentType = conn.contentType.orEmpty().lowercase()
            val accumulated = StringBuilder()
            var chunkCount = 0

            if (contentType.contains("text/event-stream")) {
                BufferedReader(InputStreamReader(conn.inputStream, StandardCharsets.UTF_8)).use { reader ->
                    while (currentCoroutineContext().isActive) {
                        val line = reader.readLine() ?: break
                        val trimmed = line.trim()
                        if (!trimmed.startsWith("data:")) continue
                        val dataStr = trimmed.removePrefix("data:").trim()
                        if (dataStr == "[DONE]") break
                        val json = runCatching { JSONObject(dataStr) }.getOrNull() ?: continue
                        val choices = json.optJSONArray("choices") ?: continue
                        val choice0 = choices.optJSONObject(0) ?: continue
                        val delta = choice0.optJSONObject("delta")?.optString("content")
                            ?: choice0.optJSONObject("message")?.optString("content")
                            ?: ""
                        if (delta.isNotEmpty()) {
                            accumulated.append(delta)
                            chunkCount++
                            val elapsedSec = ((System.currentTimeMillis() - startMs).coerceAtLeast(50L)) / 1000f
                            val estTokens = (accumulated.length / 4).coerceAtLeast(chunkCount)
                            val tps = estTokens / elapsedSec
                            onDelta(accumulated.toString(), estTokens, tps)
                        }
                    }
                }
            } else {
                val body = conn.inputStream.bufferedReader(StandardCharsets.UTF_8).use { it.readText() }
                val json = JSONObject(body)
                val content = json.optJSONArray("choices")
                    ?.optJSONObject(0)
                    ?.optJSONObject("message")
                    ?.optString("content")
                    .orEmpty()
                accumulated.append(content)
                val elapsedSec = ((System.currentTimeMillis() - startMs).coerceAtLeast(50L)) / 1000f
                val estTokens = (accumulated.length / 4).coerceAtLeast(1)
                val tps = estTokens / elapsedSec
                onDelta(accumulated.toString(), estTokens, tps)
            }

            val totalMs = (System.currentTimeMillis() - startMs).coerceAtLeast(1L)
            val finalTokens = (accumulated.length / 4).coerceAtLeast(chunkCount.coerceAtLeast(1))
            val finalTps = finalTokens / (totalMs / 1000f)
            Result.success(Triple(accumulated.toString(), finalTps, totalMs))
        } catch (e: Exception) {
            Result.failure(e)
        } finally {
            conn?.disconnect()
        }
    }
}
