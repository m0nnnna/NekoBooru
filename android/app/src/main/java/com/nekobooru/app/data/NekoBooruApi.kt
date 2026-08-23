package com.nekobooru.app.data

import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.ResponseBody
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import retrofit2.converter.kotlinx.serialization.asConverterFactory
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.Multipart
import retrofit2.http.POST
import retrofit2.http.Part
import retrofit2.http.Query
import retrofit2.http.Streaming
import retrofit2.http.Url
import java.util.concurrent.TimeUnit

interface NekoBooruApi {
    @GET("api/health")
    suspend fun health(): HealthDto

    @GET("api/posts")
    suspend fun listPosts(
        @Query("q") q: String = "",
        @Query("page") page: Int = 1,
        @Query("limit") limit: Int = 42,
    ): PostListResponse

    @GET("api/sync/changes")
    suspend fun getChanges(
        @Query("since") since: Long = 0,
        @Query("limit") limit: Int = 500,
    ): SyncChangesResponse

    @Multipart
    @POST("api/uploads")
    suspend fun upload(@Part content: MultipartBody.Part): UploadTokenDto

    /** Server downloads a direct image/video link and returns an upload token. */
    @POST("api/uploads/from-url")
    suspend fun uploadFromUrl(@Body body: UrlFetchDto): UrlUploadResultDto

    /** Server downloads a video-platform link via yt-dlp (using its cookies) and returns a token. */
    @POST("api/uploads/from-ytdlp")
    suspend fun uploadFromYtdlp(@Body body: UrlFetchDto): UrlUploadResultDto

    /** Server fetches all media from a Pleroma/Misskey post and returns a token per attachment. */
    @POST("api/uploads/from-fediverse")
    suspend fun uploadFromFediverse(@Body body: UrlFetchDto): FediverseUploadResultDto

    @POST("api/sync/push")
    suspend fun push(@Body body: PushRequestDto): PushResponseDto

    /** Stream an original media file (pass an absolute URL). */
    @Streaming
    @GET
    suspend fun download(@Url url: String): ResponseBody

    /**
     * Username/password -> a fresh API token. Every other endpoint requires a
     * logged-in user now; this is how the app obtains a bearer token to send
     * as `Authorization: Bearer <token>` without holding a session cookie
     * (see the matching comment on the backend route).
     */
    @POST("api/auth/token-login")
    suspend fun tokenLogin(@Body body: TokenLoginRequestDto): TokenLoginResponseDto
}

/** Builds a [NekoBooruApi] bound to a given server base URL (e.g. http://10.0.2.2:8000/). */
object ApiFactory {
    val json = Json {
        ignoreUnknownKeys = true
        coerceInputValues = true
    }

    fun create(baseUrl: String, apiToken: String? = null): NekoBooruApi {
        val normalized = normalizeBaseUrl(baseUrl)
        return Retrofit.Builder()
            .baseUrl(normalized)
            .client(authenticatedHttpClient(apiToken))
            .addConverterFactory(json.asConverterFactory("application/json".toMediaType()))
            .build()
            .create(NekoBooruApi::class.java)
    }

    /**
     * An [OkHttpClient] that attaches the stored token as a Bearer header, for
     * use anywhere that talks to the instance outside Retrofit - Coil's global
     * image loader and ExoPlayer's media source both stream `contentUrl`/
     * `thumbUrl` directly and need the same header every other request gets.
     */
    fun authenticatedHttpClient(apiToken: String?): OkHttpClient {
        // Log requests to logcat (tag: OkHttp) so connection issues are diagnosable.
        // Cleartext, LAN-only app, so logging the body is acceptable here.
        val logging = HttpLoggingInterceptor().apply { level = HttpLoggingInterceptor.Level.BASIC }
        val builder = OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .addInterceptor(logging)
        if (!apiToken.isNullOrBlank()) {
            builder.addInterceptor { chain ->
                chain.proceed(
                    chain.request().newBuilder()
                        .header("Authorization", "Bearer $apiToken")
                        .build()
                )
            }
        }
        return builder.build()
    }

    /**
     * Normalize a user-entered server URL: trim, default the scheme to http://
     * (so `192.168.0.2:8000` works), and ensure a single trailing slash (Retrofit
     * requires it on the base URL).
     */
    fun normalizeBaseUrl(raw: String): String {
        var url = raw.trim()
        if (!url.startsWith("http://") && !url.startsWith("https://")) url = "http://$url"
        return if (url.endsWith("/")) url else "$url/"
    }

    /** Resolve a possibly-relative media URL (thumbUrl/contentUrl) against the server. */
    fun absoluteUrl(baseUrl: String, path: String): String {
        if (path.startsWith("http://") || path.startsWith("https://")) return path
        val base = normalizeBaseUrl(baseUrl).trimEnd('/')
        val rel = if (path.startsWith("/")) path else "/$path"
        return "$base$rel"
    }
}
