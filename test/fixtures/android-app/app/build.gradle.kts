plugins {
    id("com.android.application")
    kotlin("android")
}

android {
    namespace = "com.example.app"
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("com.example:widget:2.0.0@aar")
    kapt("com.google.dagger:hilt-compiler:2.51.1")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.6.1")
    "coreLibraryDesugaring"("com.android.tools:desugar_jdk_libs:2.0.4")
    implementation("org.jetbrains.kotlin:kotlin-reflect:$kotlinVersion")
}
