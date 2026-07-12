# Default ProGuard/R8 rules for the Cindro app.
# Keep Gson-serialized model classes (reflection on field names).
-keepclassmembers class com.cindro.app.data.** {
    <fields>;
}
