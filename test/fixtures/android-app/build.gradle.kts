buildscript {
    val kotlinVersion by extra("1.9.24")
    dependencies {
        classpath("com.google.gms:google-services:4.4.2")
    }
}

plugins {
    id("com.android.application") apply false
    id("org.jetbrains.kotlin.android") version "1.9.24" apply false
}
