package com.pocketagent.app.data

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

/* ------------------------------------------------------------------ */
/* Enums                                                               */
/* ------------------------------------------------------------------ */

@Serializable
enum class AgentMode { @SerialName("yolo") YOLO, @SerialName("auto") AUTO, @SerialName("acceptEdits") ACCEPT_EDITS, @SerialName("ask") ASK;

    companion object {
        fun fromRaw(raw: String): AgentMode? = entries.firstOrNull { it.name.equals(raw, ignoreCase = true) }
    }
}

/** AdapterId is an open string in the contract (server-side plugin registry) -> plain String. */

@Serializable
data class AdapterCapabilities(
    val approvals: Boolean = false,
    val resume: Boolean = false,
    val streaming: Boolean = false,
    val autoPush: Boolean = false,
    /** Adapter maps reasoningEffort onto a runtime option. */
    val reasoning: Boolean = false,
    /** Adapter honours a per-prompt model override. */
    val modelSwitch: Boolean = false,
)

/** Normalized reasoning budget accepted by session.update. */
@Serializable
enum class ReasoningEffort { @SerialName("low") LOW, @SerialName("medium") MEDIUM, @SerialName("high") HIGH;

    companion object {
        fun fromRaw(raw: String?): ReasoningEffort? =
            raw?.let { value -> entries.firstOrNull { it.name.equals(value, ignoreCase = true) } }
    }
}

fun ReasoningEffort.wireName(): String = name.lowercase()

/** One entry of a shim's model catalog (session.models). */
@Serializable
data class ModelInfo(
    val id: String,
    val name: String? = null,
)

@Serializable
data class AdapterDefaults(val provider: String = "", val model: String? = null)

/**
 * Anzeige-Metadaten zu einem Zugang eines Adapters (id == Secret-Art).
 * Rein kosmetisch; ältere Server liefern das Feld nicht.
 */
@Serializable
data class ProviderDescriptor(
    val id: String,
    val name: String,
    val keyUrl: String? = null,
    val hint: String? = null,
)

@Serializable
data class AdapterDescriptor(
    val id: String,
    val name: String,
    val description: String? = null,
    val image: String? = null,
    val capabilities: AdapterCapabilities = AdapterCapabilities(),
    val credentials: Map<String, List<String>> = emptyMap(),
    @SerialName("providerEnv") val providerEnv: Map<String, String> = emptyMap(),
    val providers: List<ProviderDescriptor> = emptyList(),
    val defaults: AdapterDefaults = AdapterDefaults(),
)

@Serializable
enum class SessionStatus {
    @SerialName("creating") CREATING,
    @SerialName("running") RUNNING,
    @SerialName("idle") IDLE,
    @SerialName("stopped") STOPPED,
    @SerialName("error") ERROR;

    companion object {
        fun fromRaw(raw: String): SessionStatus? = entries.firstOrNull { it.name.equals(raw, ignoreCase = true) }
    }
}

@Serializable
enum class PermissionDecision { @SerialName("once") ONCE, @SerialName("always") ALWAYS, @SerialName("reject") REJECT;

    companion object {
        fun fromRaw(raw: String): PermissionDecision? = entries.firstOrNull { it.name.equals(raw, ignoreCase = true) }
    }
}

@Serializable
enum class PermissionKind {
    @SerialName("bash") BASH, @SerialName("edit") EDIT, @SerialName("webfetch") WEBFETCH,
    @SerialName("external") EXTERNAL, @SerialName("other") OTHER;

    companion object {
        fun fromRaw(raw: String): PermissionKind? = entries.firstOrNull { it.name.equals(raw, ignoreCase = true) }
    }
}

/** SecretKind is an open string in the contract -> plain String on the client. */

/* ------------------------------------------------------------------ */
/* Payload types                                                       */
/* ------------------------------------------------------------------ */

@Serializable
data class TokenUsage(
    val input: Int? = null,
    val output: Int? = null,
    @SerialName("costUsd") val costUsd: Double? = null,
)

@Serializable
data class SessionInfo(
    val id: String,
    val repoId: String,
    val repoFullName: String? = null,
    val adapter: String,
    val provider: String,
    val model: String,
    val mode: AgentMode,
    val status: SessionStatus,
    val branch: String,
    val createdAt: String,
    val lastActiveAt: String,
    val prUrl: String? = null,
    val networkPolicy: String? = null,
    val reasoningEffort: String? = null,
)

@Serializable
data class RepoInfo(
    val id: String,
    val fullName: String,
    val defaultBranch: String,
)

@Serializable
data class SecretInfo(
    val id: String,
    val kind: String,
    val createdAt: String,
)

@Serializable
data class DiffEntry(
    val path: String,
    val patch: String,
    val binary: Boolean? = null,
)

@Serializable
data class ServerStats(
    val sessionsActive: Int = 0,
    val sessionsTotal: Int = 0,
    val containersRunning: Int = 0,
    val uptimeSec: Long = 0,
    val versions: Map<String, String> = emptyMap(),
)

/* ------------------------------------------------------------------ */
/* AgentEvent (normalized stream, inside session.event)                */
/* ------------------------------------------------------------------ */

sealed interface AgentEvent {
    data class Status(
        val adapter: String,
        val sessionRef: String? = null,
        val provider: String? = null,
        val model: String? = null,
        val mode: AgentMode,
        val busy: Boolean,
    ) : AgentEvent

    data class MessageDelta(val role: String, val delta: String) : AgentEvent
    data class MessageCompleted(val role: String, val text: String) : AgentEvent
    data class ToolCall(
        val id: String,
        val tool: String,
        val input: JsonElement? = null,
        val title: String? = null,
    ) : AgentEvent

    data class ToolResult(
        val id: String,
        val tool: String,
        val output: String,
        val isError: Boolean? = null,
    ) : AgentEvent

    data class PermissionRequest(
        val permissionId: String,
        val kind: PermissionKind,
        val title: String,
        val detail: String? = null,
        val diff: String? = null,
        val patterns: List<String> = emptyList(),
    ) : AgentEvent

    data class PermissionResolved(val permissionId: String, val decision: PermissionDecision) : AgentEvent
    data class TurnCompleted(
        val summary: String? = null,
        val usage: TokenUsage? = null,
        val commitSha: String? = null,
    ) : AgentEvent

    data class TurnFailed(val error: String) : AgentEvent
    data class Pushed(val branch: String, val prUrl: String? = null, val auto: Boolean) : AgentEvent
    data class ErrorEvent(val message: String, val fatal: Boolean? = null) : AgentEvent
    data class Ping(val ts: Long) : AgentEvent
}

/* ------------------------------------------------------------------ */
/* ServerMessage                                                       */
/* ------------------------------------------------------------------ */

sealed interface ServerMessage {
    val type: String

    data class Welcome(val ok: Boolean, val serverVersion: String) : ServerMessage {
        override val type: String get() = "welcome"
    }

    data class ErrorMsg(
        val requestId: String? = null,
        val sessionId: String? = null,
        val message: String,
    ) : ServerMessage {
        override val type: String get() = "error"
    }

    data class RequestOk(val requestId: String, val payload: JsonElement? = null) : ServerMessage {
        override val type: String get() = "request.ok"
    }

    data class SessionListMsg(val requestId: String, val sessions: List<SessionInfo>) : ServerMessage {
        override val type: String get() = "session.list"
    }

    data class SessionEventMsg(val sessionId: String, val event: AgentEvent) : ServerMessage {
        override val type: String get() = "session.event"
    }

    data class SessionDiffMsg(val requestId: String, val sessionId: String, val diff: List<DiffEntry>) : ServerMessage {
        override val type: String get() = "session.diff"
    }

    data class SessionStatusMsg(val sessionId: String, val status: SessionStatus, val session: SessionInfo? = null) : ServerMessage {
        override val type: String get() = "session.status"
    }

    data class SessionDeletedMsg(val requestId: String, val sessionId: String) : ServerMessage {
        override val type: String get() = "session.deleted"
    }

    data class SessionModelsMsg(
        val requestId: String,
        val sessionId: String,
        val models: List<ModelInfo>,
    ) : ServerMessage {
        override val type: String get() = "session.models"
    }

    data class AdapterListMsg(val requestId: String, val adapters: List<AdapterDescriptor>) : ServerMessage {
        override val type: String get() = "adapter.list"
    }

    data class RepoListMsg(val requestId: String, val repos: List<RepoInfo>) : ServerMessage {
        override val type: String get() = "repo.list"
    }

    data class RepoAddedMsg(val requestId: String, val repo: RepoInfo) : ServerMessage {
        override val type: String get() = "repo.added"
    }

    data class SecretListMsg(val requestId: String, val secrets: List<SecretInfo>) : ServerMessage {
        override val type: String get() = "secret.list"
    }

    data class SecretSavedMsg(val requestId: String, val secret: SecretInfo) : ServerMessage {
        override val type: String get() = "secret.saved"
    }

    data class SecretDeletedMsg(val requestId: String, val id: String) : ServerMessage {
        override val type: String get() = "secret.deleted"
    }

    /**
     * Ergebnis einer Live-Prüfung. Enthält nie den Wert.
     * [unverified] = für diese Art gibt es keine Prüfung; [ok] ist dann true,
     * die UI zeigt das aber neutral statt als Erfolg.
     */
    data class SecretValidatedMsg(
        val requestId: String,
        val kind: String,
        val ok: Boolean,
        val detail: String? = null,
        val unverified: Boolean = false,
    ) : ServerMessage {
        override val type: String get() = "secret.validated"
    }

    data class ServerStatsMsg(val requestId: String, val stats: ServerStats) : ServerMessage {
        override val type: String get() = "server.stats"
    }
}

fun requestIdOf(msg: ServerMessage): String? = when (msg) {
    is ServerMessage.ErrorMsg -> msg.requestId
    is ServerMessage.RequestOk -> msg.requestId
    is ServerMessage.SessionListMsg -> msg.requestId
    is ServerMessage.SessionDiffMsg -> msg.requestId
    is ServerMessage.SessionDeletedMsg -> msg.requestId
    is ServerMessage.SessionModelsMsg -> msg.requestId
    is ServerMessage.AdapterListMsg -> msg.requestId
    is ServerMessage.RepoListMsg -> msg.requestId
    is ServerMessage.RepoAddedMsg -> msg.requestId
    is ServerMessage.SecretListMsg -> msg.requestId
    is ServerMessage.SecretSavedMsg -> msg.requestId
    is ServerMessage.SecretDeletedMsg -> msg.requestId
    is ServerMessage.SecretValidatedMsg -> msg.requestId
    is ServerMessage.ServerStatsMsg -> msg.requestId
    else -> null
}

/* ------------------------------------------------------------------ */
/* JSON                                                                */
/* ------------------------------------------------------------------ */

val ProtocolJson: Json = Json {
    ignoreUnknownKeys = true
    isLenient = true
    explicitNulls = false
}

private fun JsonObject.optString(key: String): String? =
    (this[key] as? kotlinx.serialization.json.JsonPrimitive)?.takeIf { it !is kotlinx.serialization.json.JsonNull }?.content

private fun JsonObject.optStringList(key: String): List<String> =
    (this[key] as? kotlinx.serialization.json.JsonArray)?.mapNotNull { (it as? kotlinx.serialization.json.JsonPrimitive)?.content } ?: emptyList()

fun parseAgentEvent(obj: JsonObject): AgentEvent? {
    val type = obj.optString("type") ?: return null
    return try {
        when (type) {
            "status" -> AgentEvent.Status(
                adapter = obj.optString("adapter") ?: return null,
                sessionRef = obj.optString("sessionRef"),
                provider = obj.optString("provider"),
                model = obj.optString("model"),
                mode = AgentMode.fromRaw(obj.optString("mode") ?: "") ?: return null,
                busy = obj["busy"]?.jsonPrimitive?.booleanOrNullCompat() ?: false,
            )

            "message.delta" -> AgentEvent.MessageDelta(
                role = obj.optString("role") ?: "assistant",
                delta = obj.optString("delta") ?: "",
            )

            "message.completed" -> AgentEvent.MessageCompleted(
                role = obj.optString("role") ?: "assistant",
                text = obj.optString("text") ?: "",
            )

            "tool.call" -> AgentEvent.ToolCall(
                id = obj.optString("id") ?: "",
                tool = obj.optString("tool") ?: "",
                input = obj["input"],
                title = obj.optString("title"),
            )

            "tool.result" -> AgentEvent.ToolResult(
                id = obj.optString("id") ?: "",
                tool = obj.optString("tool") ?: "",
                output = obj.optString("output") ?: "",
                isError = obj["isError"]?.jsonPrimitive?.booleanOrNullCompat(),
            )

            "permission.request" -> AgentEvent.PermissionRequest(
                permissionId = obj.optString("permissionId") ?: "",
                kind = PermissionKind.fromRaw(obj.optString("kind") ?: "other") ?: PermissionKind.OTHER,
                title = obj.optString("title") ?: "",
                detail = obj.optString("detail"),
                diff = obj.optString("diff"),
                patterns = obj.optStringList("patterns"),
            )

            "permission.resolved" -> AgentEvent.PermissionResolved(
                permissionId = obj.optString("permissionId") ?: "",
                decision = PermissionDecision.fromRaw(obj.optString("decision") ?: "") ?: return null,
            )

            "turn.completed" -> AgentEvent.TurnCompleted(
                summary = obj.optString("summary"),
                usage = (obj["usage"] as? JsonObject)?.let { u ->
                    TokenUsage(
                        input = u["input"]?.jsonPrimitive?.intOrNull,
                        output = u["output"]?.jsonPrimitive?.intOrNull,
                        costUsd = u["costUsd"]?.jsonPrimitive?.doubleOrNull,
                    )
                },
                commitSha = obj.optString("commitSha"),
            )

            "turn.failed" -> AgentEvent.TurnFailed(error = obj.optString("error") ?: "unknown error")

            "pushed" -> AgentEvent.Pushed(
                branch = obj.optString("branch") ?: "",
                prUrl = obj.optString("prUrl"),
                auto = obj["auto"]?.jsonPrimitive?.booleanOrNullCompat() ?: false,
            )

            "error" -> AgentEvent.ErrorEvent(
                message = obj.optString("message") ?: "unknown error",
                fatal = obj["fatal"]?.jsonPrimitive?.booleanOrNullCompat(),
            )

            "ping" -> AgentEvent.Ping(ts = obj["ts"]?.jsonPrimitive?.longOrNull ?: 0L)

            else -> null
        }
    } catch (_: Exception) {
        null
    }
}

private fun kotlinx.serialization.json.JsonPrimitive.booleanOrNullCompat(): Boolean? = when (content.lowercase()) {
    "true" -> true
    "false" -> false
    else -> null
}

fun parseServerMessage(raw: String): ServerMessage? {
    return try {
        val root = ProtocolJson.parseToJsonElement(raw).jsonObject
        val type = root.optString("type") ?: return null
        when (type) {
            "welcome" -> ServerMessage.Welcome(
                ok = root["ok"]?.jsonPrimitive?.booleanOrNullCompat() ?: true,
                serverVersion = root.optString("serverVersion") ?: "",
            )

            "error" -> ServerMessage.ErrorMsg(
                requestId = root.optString("requestId"),
                sessionId = root.optString("sessionId"),
                message = root.optString("message") ?: "unknown error",
            )

            "request.ok" -> ServerMessage.RequestOk(
                requestId = root.optString("requestId") ?: return null,
                payload = root["payload"],
            )

            "session.list" -> ServerMessage.SessionListMsg(
                requestId = root.optString("requestId") ?: return null,
                sessions = root["sessions"]?.jsonArray?.mapNotNull { el ->
                    runCatching { ProtocolJson.decodeFromJsonElement(SessionInfo.serializer(), el) }.getOrNull()
                } ?: emptyList(),
            )

            "session.event" -> {
                val event = (root["event"] as? JsonObject)?.let { parseAgentEvent(it) } ?: return null
                ServerMessage.SessionEventMsg(
                    sessionId = root.optString("sessionId") ?: return null,
                    event = event,
                )
            }

            "session.diff" -> ServerMessage.SessionDiffMsg(
                requestId = root.optString("requestId") ?: return null,
                sessionId = root.optString("sessionId") ?: return null,
                diff = root["diff"]?.jsonArray?.mapNotNull { el ->
                    runCatching { ProtocolJson.decodeFromJsonElement(DiffEntry.serializer(), el) }.getOrNull()
                } ?: emptyList(),
            )

            "session.status" -> ServerMessage.SessionStatusMsg(
                sessionId = root.optString("sessionId") ?: return null,
                status = SessionStatus.fromRaw(root.optString("status") ?: "") ?: return null,
                session = (root["session"] as? JsonObject)?.let {
                    runCatching { ProtocolJson.decodeFromJsonElement(SessionInfo.serializer(), it) }.getOrNull()
                },
            )

            "session.models" -> ServerMessage.SessionModelsMsg(
                requestId = root.optString("requestId") ?: return null,
                sessionId = root.optString("sessionId") ?: return null,
                models = root["models"]?.jsonArray?.mapNotNull { el ->
                    runCatching { ProtocolJson.decodeFromJsonElement(ModelInfo.serializer(), el) }.getOrNull()
                } ?: emptyList(),
            )

            "session.deleted" -> ServerMessage.SessionDeletedMsg(
                requestId = root.optString("requestId") ?: return null,
                sessionId = root.optString("sessionId") ?: return null,
            )

            "adapter.list" -> ServerMessage.AdapterListMsg(
                requestId = root.optString("requestId") ?: return null,
                adapters = root["adapters"]?.jsonArray?.mapNotNull { el ->
                    runCatching { ProtocolJson.decodeFromJsonElement(AdapterDescriptor.serializer(), el) }.getOrNull()
                } ?: emptyList(),
            )

            "repo.list" -> ServerMessage.RepoListMsg(
                requestId = root.optString("requestId") ?: return null,
                repos = root["repos"]?.jsonArray?.mapNotNull { el ->
                    runCatching { ProtocolJson.decodeFromJsonElement(RepoInfo.serializer(), el) }.getOrNull()
                } ?: emptyList(),
            )

            "repo.added" -> ServerMessage.RepoAddedMsg(
                requestId = root.optString("requestId") ?: return null,
                repo = runCatching { ProtocolJson.decodeFromJsonElement(RepoInfo.serializer(), root["repo"] ?: return null) }.getOrNull() ?: return null,
            )

            "secret.list" -> ServerMessage.SecretListMsg(
                requestId = root.optString("requestId") ?: return null,
                secrets = root["secrets"]?.jsonArray?.mapNotNull { el ->
                    runCatching { ProtocolJson.decodeFromJsonElement(SecretInfo.serializer(), el) }.getOrNull()
                } ?: emptyList(),
            )

            "secret.saved" -> ServerMessage.SecretSavedMsg(
                requestId = root.optString("requestId") ?: return null,
                secret = runCatching { ProtocolJson.decodeFromJsonElement(SecretInfo.serializer(), root["secret"] ?: return null) }.getOrNull() ?: return null,
            )

            "secret.deleted" -> ServerMessage.SecretDeletedMsg(
                requestId = root.optString("requestId") ?: return null,
                id = root.optString("id") ?: return null,
            )

            "secret.validated" -> ServerMessage.SecretValidatedMsg(
                requestId = root.optString("requestId") ?: return null,
                kind = root.optString("kind") ?: return null,
                ok = root["ok"]?.jsonPrimitive?.booleanOrNullCompat() ?: false,
                detail = root.optString("detail"),
                unverified = root["unverified"]?.jsonPrimitive?.booleanOrNullCompat() ?: false,
            )

            "server.stats" -> ServerMessage.ServerStatsMsg(
                requestId = root.optString("requestId") ?: return null,
                stats = (root["stats"] as? JsonObject)?.let { s ->
                    ServerStats(
                        sessionsActive = s["sessionsActive"]?.jsonPrimitive?.intOrNull ?: 0,
                        sessionsTotal = s["sessionsTotal"]?.jsonPrimitive?.intOrNull ?: 0,
                        containersRunning = s["containersRunning"]?.jsonPrimitive?.intOrNull ?: 0,
                        uptimeSec = s["uptimeSec"]?.jsonPrimitive?.longOrNull ?: 0L,
                        versions = s["versions"]?.jsonObject?.mapNotNull { (k, v) ->
                            (v as? kotlinx.serialization.json.JsonPrimitive)?.let { k to it.content }
                        }?.toMap() ?: emptyMap(),
                    )
                } ?: return null,
            )

            else -> null
        }
    } catch (_: Exception) {
        null
    }
}

/* ------------------------------------------------------------------ */
/* ClientMessage encoder                                               */
/* ------------------------------------------------------------------ */

fun AgentMode.wireName(): String = when (this) {
    AgentMode.YOLO -> "yolo"
    AgentMode.AUTO -> "auto"
    AgentMode.ACCEPT_EDITS -> "acceptEdits"
    AgentMode.ASK -> "ask"
}

fun encodeHello(deviceId: String, token: String): String = buildJsonObject {
    put("type", "hello")
    put("deviceId", deviceId)
    put("token", token)
}.toString()

fun encodeSessionCreate(
    requestId: String,
    repoId: String,
    adapter: String,
    provider: String,
    model: String,
    mode: AgentMode,
    branch: String?,
    networkPolicy: String? = null,
): String = buildJsonObject {
    put("type", "session.create")
    put("requestId", requestId)
    put("repoId", repoId)
    put("adapter", adapter)
    put("provider", provider)
    put("model", model)
    put("mode", mode.wireName())
    branch?.let { put("branch", it) }
    networkPolicy?.let { put("networkPolicy", it) }
}.toString()

fun encodeSessionPrompt(sessionId: String, text: String, mode: AgentMode?): String = buildJsonObject {
    put("type", "session.prompt")
    put("sessionId", sessionId)
    put("text", text)
    mode?.let { put("mode", it.wireName()) }
}.toString()

/**
 * Mode/Modell/Reasoning einer laufenden Session ändern. Alle Felder optional;
 * leerer Modell-String setzt auf den Adapter-Default zurück.
 */
fun encodeSessionUpdate(
    requestId: String,
    sessionId: String,
    mode: AgentMode? = null,
    model: String? = null,
    reasoningEffort: ReasoningEffort? = null,
): String = buildJsonObject {
    put("type", "session.update")
    put("requestId", requestId)
    put("sessionId", sessionId)
    mode?.let { put("mode", it.wireName()) }
    model?.let { put("model", it) }
    reasoningEffort?.let { put("reasoningEffort", it.wireName()) }
}.toString()

fun encodeSessionModelsGet(requestId: String, sessionId: String): String = buildJsonObject {
    put("type", "session.models.get")
    put("requestId", requestId)
    put("sessionId", sessionId)
}.toString()

fun encodeSessionPermission(sessionId: String, permissionId: String, decision: PermissionDecision): String = buildJsonObject {
    put("type", "session.permission")
    put("sessionId", sessionId)
    put("permissionId", permissionId)
    put("decision", decision.name.lowercase())
}.toString()

private fun sessionCommand(type: String, sessionId: String): String = buildJsonObject {
    put("type", type)
    put("sessionId", sessionId)
}.toString()

fun encodeSessionAbort(sessionId: String): String = sessionCommand("session.abort", sessionId)
fun encodeSessionStop(sessionId: String): String = sessionCommand("session.stop", sessionId)
fun encodeSessionResume(sessionId: String): String = sessionCommand("session.resume", sessionId)
fun encodeSessionPush(sessionId: String): String = sessionCommand("session.push", sessionId)

fun encodeSessionDiffGet(requestId: String, sessionId: String): String = buildJsonObject {
    put("type", "session.diff.get")
    put("requestId", requestId)
    put("sessionId", sessionId)
}.toString()

private fun requestCommand(type: String, requestId: String): String = buildJsonObject {
    put("type", type)
    put("requestId", requestId)
}.toString()

fun encodeSessionList(requestId: String): String = requestCommand("session.list", requestId)
fun encodeAdapterList(requestId: String): String = requestCommand("adapter.list", requestId)
fun encodeRepoList(requestId: String): String = requestCommand("repo.list", requestId)
fun encodeSecretList(requestId: String): String = requestCommand("secret.list", requestId)
fun encodeServerStats(requestId: String): String = requestCommand("server.stats", requestId)

fun encodeSessionDelete(requestId: String, sessionId: String): String = buildJsonObject {
    put("type", "session.delete")
    put("requestId", requestId)
    put("sessionId", sessionId)
}.toString()

fun encodeRepoAdd(requestId: String, fullName: String, defaultBranch: String): String = buildJsonObject {
    put("type", "repo.add")
    put("requestId", requestId)
    put("fullName", fullName)
    put("defaultBranch", defaultBranch)
}.toString()

fun encodeSecretSet(requestId: String, kind: String, value: String): String = buildJsonObject {
    put("type", "secret.set")
    put("requestId", requestId)
    put("kind", kind)
    put("value", value)
}.toString()

/**
 * Key beim Anbieter prüfen lassen, ohne ihn zu speichern. Der Wert geht nur
 * für die Prüfung an den Server und kommt nie zurück.
 */
fun encodeSecretValidate(requestId: String, kind: String, value: String): String = buildJsonObject {
    put("type", "secret.validate")
    put("requestId", requestId)
    put("kind", kind)
    put("value", value)
}.toString()

fun encodeSecretDelete(requestId: String, id: String): String = buildJsonObject {
    put("type", "secret.delete")
    put("requestId", requestId)
    put("id", id)
}.toString()

fun encodeFcmRegister(token: String): String = buildJsonObject {
    put("type", "fcm.register")
    put("token", token)
}.toString()
