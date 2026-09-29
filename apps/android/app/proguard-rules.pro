# kotlinx.serialization: keep generated serializers for @Serializable DTOs and navigation routes.
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.**
-keepclassmembers @kotlinx.serialization.Serializable class app.wabrain.** {
    *** Companion;
    static ** INSTANCE;
    kotlinx.serialization.KSerializer serializer(...);
}
-keepclasseswithmembers class app.wabrain.** {
    kotlinx.serialization.KSerializer serializer(...);
}
-if @kotlinx.serialization.Serializable class **
-keepclassmembers class <1>$Companion {
    kotlinx.serialization.KSerializer serializer(...);
}

# ZXing is used reflectively only through MultiFormatReader hints; keep decoders.
-keep class com.google.zxing.qrcode.** { *; }

# UnifiedPush connector bundles Tink's web push helper; Tink uses protobuf-lite reflection.
-keep class com.google.crypto.tink.** { *; }
-dontwarn com.google.errorprone.annotations.**
-dontwarn javax.annotation.**
-dontwarn com.google.api.client.**
-dontwarn org.joda.time.**

# Glance action callbacks are instantiated by class name.
-keep class * implements androidx.glance.appwidget.action.ActionCallback { <init>(); }

# Workers are instantiated reflectively by WorkManager's default factory.
-keep class * extends androidx.work.ListenableWorker { <init>(android.content.Context, androidx.work.WorkerParameters); }
