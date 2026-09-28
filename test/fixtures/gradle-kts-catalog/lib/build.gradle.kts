plugins {
    `java-library`
}

repositories {
    maven(url = "https://maven.lib.example.com")
}

dependencies {
    api("org.slf4j:slf4j-api:$slf4jVersion")
}
