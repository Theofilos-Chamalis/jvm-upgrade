val roomVersion = "2.6.1"
val lifecycleVersion: String by project

plugins {
    kotlin("jvm")
}

dependencies {
    implementation(platform("com.squareup.okhttp3:okhttp-bom:4.12.0"))
    implementation("androidx.room:room-runtime:$roomVersion")
    ksp("androidx.room:room-compiler:${roomVersion}")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:$lifecycleVersion")
    implementation(group = "com.squareup.retrofit2", name = "retrofit", version = "2.11.0")
    implementation(libs.coroutines.core)
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:${libs.versions.coroutines.get()}")
    testImplementation(kotlin("test", "2.0.0"))
    // implementation("commented:out:1.0")
    /* implementation("block:commented:1.0") */
    implementation("com.example:dyn:1.+")
    implementation("com.example:range:[1.0,2.0)")
    implementation("com.example:classified:1.2.3:linux-x86_64")
    implementation("com.example:mixed:$roomVersion-beta")
    implementation("com.example:unresolved:$missing")
}
