package com.nekobooru.app.data

import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import retrofit2.Retrofit
import retrofit2.converter.kotlinx.serialization.asConverterFactory
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.Multipart
import retrofit2.http.POST
import retrofit2.http.Part
import retrofit2.http.Query
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

    @POST("api/sync/push")
    suspend fun push(@Body body: PushRequestDto): PushResponseDto
}

/** Builds a [NekoBooruApi] bound to a given server base URL (e.g. http://10.0.2.2:8000/). */
object ApiFactory {
    val json = Json {
        ignoreUnknownKeys = true
        coerceInputValues = true
    }

    fun create(baseUrl: String): NekoBooruApi {
        val normalized = if (baseUrl.endsWith("/")) baseUrl else "$baseUrl/"
        val client = OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .build()
        return Retrofit.Builder()
            .baseUrl(normalized)
            .client(client)
            .addConverterFactory(json.asConverterFactory("application/json".toMediaType()))
            .build()
            .create(NekoBooruApi::class.java)
    }

    /** Resolve a possibly-relative media URL (thumbUrl/contentUrl) against the server. */
    fun absoluteUrl(baseUrl: String, path: String): String {
        if (path.startsWith("http://") || path.startsWith("https://")) return path
        val base = baseUrl.trimEnd('/')
        val rel = if (path.startsWith("/")) path else "/$path"
        return "$base$rel"
    }
}
