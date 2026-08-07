use std::path::{Path, PathBuf};

use tokio::process::Command;

#[derive(Debug, Clone)]
pub struct PreparedChunk {
    pub path: PathBuf,
    pub duration_seconds: f64,
}

/// Where the FFmpeg binary lives. The packaged app passes the bundled resource path; a dev run
/// falls back to `AUDIO_TRANSCRIBER_FFMPEG`, then the `ffmpeg-static` package, then `PATH`.
pub fn resolve_ffmpeg(bundled: Option<&Path>) -> PathBuf {
    if let Ok(from_env) = std::env::var("AUDIO_TRANSCRIBER_FFMPEG") {
        if !from_env.trim().is_empty() {
            return PathBuf::from(from_env);
        }
    }
    if let Some(path) = bundled {
        if path.is_file() {
            return path.to_path_buf();
        }
    }
    // Developer convenience: the repo already carries a binary via npm.
    let name = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };
    let from_node_modules = PathBuf::from("node_modules/ffmpeg-static").join(name);
    if from_node_modules.is_file() {
        return from_node_modules;
    }
    PathBuf::from("ffmpeg")
}

#[derive(Clone)]
pub struct FfmpegMedia {
    work_directory: PathBuf,
    ffmpeg: PathBuf,
}

impl FfmpegMedia {
    pub fn new(work_directory: impl Into<PathBuf>, ffmpeg: impl Into<PathBuf>) -> Self {
        Self {
            work_directory: work_directory.into(),
            ffmpeg: ffmpeg.into(),
        }
    }

    /// Transcodes to mono 16 kHz MP3 and splits into 20-minute chunks. The arguments are the ones
    /// the TypeScript backend used, unchanged — they determine chunk boundaries, and therefore
    /// every timestamp in existing transcripts.
    pub async fn prepare(&self, input: &Path, job_id: &str) -> Result<Vec<PreparedChunk>, String> {
        let directory = self.work_directory.join(job_id);
        tokio::fs::create_dir_all(&directory)
            .await
            .map_err(|e| e.to_string())?;
        let pattern = directory.join("chunk-%03d.mp3");

        let output = Command::new(&self.ffmpeg)
            .args([
                "-y",
                "-i",
                &input.to_string_lossy(),
                "-vn",
                "-ac",
                "1",
                "-ar",
                "16000",
                "-b:a",
                "64k",
                "-f",
                "segment",
                "-segment_time",
                "1200",
                "-reset_timestamps",
                "1",
                &pattern.to_string_lossy(),
            ])
            .output()
            .await
            .map_err(|e| format!("Could not run FFmpeg: {e}"))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let tail: String = stderr.lines().rev().take(4).collect::<Vec<_>>().join(" ");
            return Err(format!("FFmpeg could not read the audio. {tail}"));
        }

        let mut files = Vec::new();
        let mut entries = tokio::fs::read_dir(&directory)
            .await
            .map_err(|e| e.to_string())?;
        while let Some(entry) = entries.next_entry().await.map_err(|e| e.to_string())? {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("mp3") {
                files.push(path);
            }
        }
        // chunk-000, chunk-001, … must stay in order or every timestamp shifts.
        files.sort();
        if files.is_empty() {
            return Err("The file did not contain readable audio.".into());
        }

        let mut chunks = Vec::with_capacity(files.len());
        for file in files {
            let duration_seconds = self.duration(&file).await?;
            chunks.push(PreparedChunk {
                path: file,
                duration_seconds,
            });
        }
        Ok(chunks)
    }

    /// There is no ffprobe in the bundle, so duration comes from parsing FFmpeg's own stderr.
    async fn duration(&self, file: &Path) -> Result<f64, String> {
        let output = Command::new(&self.ffmpeg)
            .args(["-i", &file.to_string_lossy()])
            .output()
            .await
            .map_err(|e| format!("Could not run FFmpeg: {e}"))?;
        // `ffmpeg -i` with no output file always exits non-zero; the banner on stderr is the point.
        let stderr = String::from_utf8_lossy(&output.stderr);
        parse_duration(&stderr).ok_or_else(|| "Could not measure an audio chunk.".to_string())
    }
}

/// Pulls `Duration: HH:MM:SS.ss` out of an FFmpeg banner.
pub fn parse_duration(stderr: &str) -> Option<f64> {
    let start = stderr.find("Duration: ")? + "Duration: ".len();
    let rest = &stderr[start..];
    let end = rest.find(',').unwrap_or(rest.len());
    let stamp = rest[..end].trim();

    let mut parts = stamp.split(':');
    let hours: f64 = parts.next()?.trim().parse().ok()?;
    let minutes: f64 = parts.next()?.trim().parse().ok()?;
    let seconds: f64 = parts.next()?.trim().parse().ok()?;
    Some(hours * 3600.0 + minutes * 60.0 + seconds)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_duration_out_of_a_real_ffmpeg_banner() {
        let stderr = "\
Input #0, mp3, from 'chunk-000.mp3':
  Duration: 00:20:00.03, start: 0.025057, bitrate: 64 kb/s
  Stream #0:0: Audio: mp3, 16000 Hz, mono, fltp, 64 kb/s";
        let seconds = parse_duration(stderr).unwrap();
        assert!((seconds - 1200.03).abs() < 0.001, "got {seconds}");
    }

    #[test]
    fn handles_an_hour_long_chunk_and_a_short_tail() {
        assert_eq!(
            parse_duration("  Duration: 01:00:00.00, start: 0.0").unwrap(),
            3600.0
        );
        let tail = parse_duration("  Duration: 00:00:07.50, start: 0.0").unwrap();
        assert!((tail - 7.5).abs() < 0.001);
    }

    #[test]
    fn returns_nothing_when_ffmpeg_reported_no_duration() {
        assert_eq!(parse_duration("Invalid data found when processing input"), None);
        assert_eq!(parse_duration("Duration: N/A, start: 0.0"), None);
    }

    #[test]
    fn an_explicit_ffmpeg_path_overrides_everything() {
        unsafe { std::env::set_var("AUDIO_TRANSCRIBER_FFMPEG", "/opt/custom/ffmpeg") };
        assert_eq!(
            resolve_ffmpeg(Some(Path::new("/bundled/ffmpeg"))),
            PathBuf::from("/opt/custom/ffmpeg")
        );
        unsafe { std::env::remove_var("AUDIO_TRANSCRIBER_FFMPEG") };
    }
}
