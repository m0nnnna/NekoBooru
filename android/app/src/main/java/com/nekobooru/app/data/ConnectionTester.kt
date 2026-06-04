package com.nekobooru.app.data

import retrofit2.HttpException
import java.io.IOException

/**
 * Probes a server URL and returns a human-readable diagnosis. Checks both
 * `/api/health` (is this NekoBooru at all?) and `/api/sync/changes` (does it
 * have the sync layer the app needs?), so the common failure modes — wrong
 * port/scheme, an old backend without sync, or no server — are distinguishable.
 */
object ConnectionTester {

    suspend fun test(serverUrl: String): String {
        val target = ApiFactory.normalizeBaseUrl(serverUrl)
        val api = ApiFactory.create(serverUrl)

        // 1) Is anything that looks like NekoBooru answering?
        try {
            api.health()
        } catch (e: HttpException) {
            return "Reached a server at $target but /api/health returned HTTP ${e.code()}. " +
                "That host isn't NekoBooru (wrong port or a reverse proxy?)."
        } catch (e: IOException) {
            return diagnoseIo(e, target)
        } catch (e: Exception) {
            return "Couldn't reach $target: ${e.message ?: e.javaClass.simpleName}"
        }

        // 2) Health is fine — does it expose the sync layer the app needs?
        try {
            api.getChanges(since = 0, limit = 1)
        } catch (e: HttpException) {
            return if (e.code() == 404) {
                "Connected to $target, but /api/sync is missing (HTTP 404). The server is " +
                    "running an older build — update it to one with the sync layer."
            } else {
                "Connected to $target, but /api/sync returned HTTP ${e.code()}."
            }
        } catch (e: IOException) {
            return diagnoseIo(e, target)
        } catch (e: Exception) {
            return "Connected to $target, but the sync check failed: ${e.message ?: e.javaClass.simpleName}"
        }

        return "Connected to $target — health and sync both OK."
    }

    private fun diagnoseIo(e: IOException, target: String): String {
        val msg = e.message ?: ""
        return when {
            msg.contains("end of stream", ignoreCase = true) ->
                "Connection to $target dropped (\"unexpected end of stream\"). The port is open " +
                    "but didn't speak plain HTTP — it's likely serving HTTPS. Try https:// instead."
            msg.contains("CLEARTEXT", ignoreCase = true) ->
                "Cleartext HTTP to $target was blocked. Use https:// or allow cleartext for this host."
            else ->
                "Couldn't reach $target: ${msg.ifBlank { e.javaClass.simpleName }}. " +
                    "Check the IP/port and that the phone is on the same network."
        }
    }
}
