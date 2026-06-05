# R8 keep rules for the release build.
#
# Retrofit, OkHttp, Room, Coil, Media3 and Compose all ship their own consumer
# rules, so only kotlinx.serialization needs manual keeps here: R8 would
# otherwise strip the generated $serializer classes that the DTOs rely on.

-keepattributes RuntimeVisibleAnnotations,AnnotationDefault

# Keep every @Serializable type's generated serializer and Companion.
-if @kotlinx.serialization.Serializable class **
-keepclassmembers class <1> {
    static <1>$Companion Companion;
}
-if @kotlinx.serialization.Serializable class ** {
    static **$* *;
}
-keepclassmembers class <2>$<3> {
    kotlinx.serialization.KSerializer serializer(...);
}
-keepclasseswithmembers class **$$serializer {
    *;
}

# Our DTOs live here; keep them and their members so reflection-free
# serialization keeps working after shrinking.
-keep class com.nekobooru.app.data.** { *; }
