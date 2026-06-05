package com.nekobooru.app.data

import android.net.Uri

/**
 * Routes a pasted link to the matching server-side fetch endpoint, mirroring the
 * website's UploadView logic so the phone and the browser agree on what a link
 * is. The actual download (and any cookies) happens on the server.
 */
object UrlClassifier {

    enum class Kind { VIDEO, FEDIVERSE, IMAGE, UNSUPPORTED }

    private val VIDEO_PLATFORMS = listOf(
        "twitter.com", "x.com",
        "youtube.com", "youtu.be",
        "tiktok.com",
        "instagram.com",
        "reddit.com", "v.redd.it",
        "vimeo.com",
        "twitch.tv", "clips.twitch.tv",
        "dailymotion.com",
        "streamable.com",
    )

    private val IMAGE_HOSTS = listOf(
        "i.imgur.com", "imgur.com",
        "i.redd.it", "preview.redd.it",
        "pbs.twimg.com", "media.tumblr.com",
        "cdn.discordapp.com", "media.discordapp.net",
        "i.pinimg.com", "i.pximg.net",
        "gelbooru.com", "safebooru.org", "danbooru.donmai.us",
    )

    private val MEDIA_EXTS = setOf("jpg", "jpeg", "png", "gif", "webp", "webm", "mp4")

    /** True if [text] is an http(s) URL we know how to hand to the server. */
    fun looksLikeSupportedUrl(text: String): Boolean = classify(text) != Kind.UNSUPPORTED

    fun classify(text: String): Kind {
        val uri = runCatching { Uri.parse(text.trim()) }.getOrNull() ?: return Kind.UNSUPPORTED
        val scheme = uri.scheme?.lowercase()
        if (scheme != "http" && scheme != "https") return Kind.UNSUPPORTED
        val host = uri.host?.lowercase() ?: return Kind.UNSUPPORTED
        val path = uri.path ?: ""

        if (isVideoHost(host, path)) return Kind.VIDEO
        if (isFediversePath(path)) return Kind.FEDIVERSE
        if (isImage(host, path)) return Kind.IMAGE
        return Kind.UNSUPPORTED
    }

    private fun hostMatches(host: String, domain: String) =
        host == domain || host.endsWith(".$domain")

    private fun isVideoHost(host: String, path: String): Boolean {
        if (VIDEO_PLATFORMS.none { hostMatches(host, it) }) return false
        // Instagram: only reels/posts carry video.
        if (host.contains("instagram.com")) {
            return path.contains("/reel/") || path.contains("/p/")
        }
        return true
    }

    private fun isFediversePath(path: String): Boolean =
        Regex("/notes/[a-zA-Z0-9]+").containsMatchIn(path) ||      // Misskey
            Regex("/notice/[a-zA-Z0-9]+").containsMatchIn(path) || // Pleroma
            Regex("/@[^/]+/\\d+").containsMatchIn(path)            // Mastodon/Pleroma

    private fun isImage(host: String, path: String): Boolean {
        val ext = path.substringAfterLast('.', "").lowercase()
        if (ext in MEDIA_EXTS) return true
        return IMAGE_HOSTS.any { host.contains(it) }
    }
}
