use std::path::PathBuf;

const APP_FOLDER: &str = "Audio Transcriber";

/// Where transcripts and settings live, per OS convention. Deliberately the same location the
/// TypeScript backend used, so existing transcripts keep loading after this port.
pub fn app_data_directory() -> PathBuf {
    if let Ok(override_dir) = std::env::var("AUDIO_TRANSCRIBER_DATA_DIR") {
        if !override_dir.trim().is_empty() {
            return PathBuf::from(override_dir);
        }
    }
    #[cfg(target_os = "windows")]
    {
        // %APPDATA% — dirs calls this config_dir on Windows.
        if let Some(base) = dirs::config_dir() {
            return base.join(APP_FOLDER);
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Some(home) = dirs::home_dir() {
            return home
                .join("Library")
                .join("Application Support")
                .join(APP_FOLDER);
        }
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        if let Some(base) = dirs::data_dir() {
            return base.join("audio-transcriber");
        }
    }
    #[allow(unreachable_code)]
    PathBuf::from(".").join(APP_FOLDER)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Both cases live in one test on purpose: they share a process-wide environment variable,
    // and Rust runs tests in parallel, so splitting them makes each flaky.
    #[test]
    fn an_override_wins_and_the_default_is_the_per_user_app_folder() {
        // SAFETY: the variable is set and removed within this single test.
        unsafe { std::env::set_var("AUDIO_TRANSCRIBER_DATA_DIR", "/tmp/custom-location") };
        assert_eq!(app_data_directory(), PathBuf::from("/tmp/custom-location"));

        unsafe { std::env::remove_var("AUDIO_TRANSCRIBER_DATA_DIR") };
        let dir = app_data_directory();
        assert!(dir.to_string_lossy().contains("audio-transcriber") || dir.ends_with(APP_FOLDER));
    }
}
