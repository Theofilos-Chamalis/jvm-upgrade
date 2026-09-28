plugins {
    alias(libs.plugins.kotlin.jvm) apply false
    kotlin("plugin.parcelize") version "2.0.0" apply false
    id("com.github.ben-manes.versions").version("0.51.0")
}
