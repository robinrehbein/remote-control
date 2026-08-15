pluginManagement {
    repositories {
        google()
        // repo1.maven.org is the canonical Maven Central host; repo.maven.apache.org
        // is unreachable in some sandboxed environments
        maven("https://repo1.maven.org/maven2/")
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        maven("https://repo1.maven.org/maven2/")
        mavenCentral()
    }
}

rootProject.name = "PocketAgent"
include(":app")
