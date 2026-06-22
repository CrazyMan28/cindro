# Default ProGuard/R8 rules for the Jarvis app.
# Keep Gson-serialized model classes (reflection on field names).
-keepclassmembers class com.jarvis.app.data.** {
    <fields>;
}
