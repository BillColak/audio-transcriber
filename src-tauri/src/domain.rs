use crate::types::{LanguagePreference, Segment};

pub const MAX_UPLOAD_BYTES: u64 = 2 * 1024 * 1024 * 1024;

const SUPPORTED_EXTENSIONS: [&str; 9] = [
    "flac", "mp3", "mp4", "mpeg", "mpga", "m4a", "ogg", "wav", "webm",
];

pub fn validate_audio_file(filename: &str, size: u64) -> Result<(), String> {
    // Matches Node's `path.extname`: a leading dot is a hidden-file name, not an extension, so
    // ".mp3" has no extension and is rejected rather than treated as an MP3.
    let base = filename
        .rsplit(|c| c == '/' || c == '\\')
        .next()
        .unwrap_or(filename);
    let extension = match base.rfind('.') {
        Some(0) | None => String::new(),
        Some(index) => base[index + 1..].to_ascii_lowercase(),
    };
    if !SUPPORTED_EXTENSIONS.contains(&extension.as_str()) {
        return Err("Unsupported audio format.".into());
    }
    if size > MAX_UPLOAD_BYTES {
        return Err("File exceeds the 2 GB limit.".into());
    }
    if size == 0 {
        return Err("The audio file is empty.".into());
    }
    Ok(())
}

/// `gpt-transcribe` takes a `languages` array; auto-detect means sending nothing at all.
pub fn language_codes(language: LanguagePreference) -> Option<Vec<String>> {
    match language {
        LanguagePreference::Indonesian => Some(vec!["id".to_string()]),
        LanguagePreference::Auto => None,
    }
}

/// One segment per prepared chunk — the model returns no sub-segment timings, so the chunk is
/// the unit. Reintroducing per-sentence segments means changing the model first.
pub fn chunk_segment(
    text: &str,
    offset_seconds: f64,
    duration_seconds: f64,
    chunk_index: usize,
) -> Segment {
    Segment {
        id: format!("{chunk_index}-0"),
        start_seconds: offset_seconds,
        end_seconds: offset_seconds + duration_seconds,
        text: text.trim().to_string(),
    }
}

pub fn join_segments(segments: &[Segment]) -> String {
    segments
        .iter()
        .map(|segment| segment.text.trim())
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

pub fn format_timestamp(seconds: f64, milliseconds: bool) -> String {
    let total_ms = (seconds * 1000.0).round().max(0.0) as u64;
    let hours = total_ms / 3_600_000;
    let minutes = (total_ms % 3_600_000) / 60_000;
    let secs = (total_ms % 60_000) / 1000;
    let ms = total_ms % 1000;
    let base = format!("{hours:02}:{minutes:02}:{secs:02}");
    if milliseconds {
        format!("{base}.{ms:03}")
    } else {
        base
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_supported_audio_and_rejects_the_rest() {
        assert!(validate_audio_file("meeting.mp3", 1024).is_ok());
        assert!(validate_audio_file("MEETING.M4A", 1024).is_ok());
        assert_eq!(
            validate_audio_file("notes.txt", 1024).unwrap_err(),
            "Unsupported audio format."
        );
    }

    #[test]
    fn a_leading_dot_is_a_hidden_file_not_an_extension() {
        // `path.extname(".mp3")` is "" in Node, so this was rejected before the port too.
        assert!(validate_audio_file(".mp3", 1024).is_err());
        assert!(validate_audio_file("noextension", 1024).is_err());
        // A dot in a directory name must not be mistaken for the file's extension.
        assert!(validate_audio_file("my.folder/recording.mp3", 1024).is_ok());
        assert!(validate_audio_file("my.folder/recording", 1024).is_err());
    }

    #[test]
    fn rejects_an_empty_or_oversized_file() {
        assert_eq!(
            validate_audio_file("meeting.mp3", 0).unwrap_err(),
            "The audio file is empty."
        );
        assert_eq!(
            validate_audio_file("meeting.mp3", MAX_UPLOAD_BYTES + 1).unwrap_err(),
            "File exceeds the 2 GB limit."
        );
    }

    #[test]
    fn sends_no_language_when_auto_detecting() {
        assert_eq!(
            language_codes(LanguagePreference::Indonesian),
            Some(vec!["id".to_string()])
        );
        assert_eq!(language_codes(LanguagePreference::Auto), None);
    }

    #[test]
    fn builds_one_segment_per_chunk_with_a_running_offset() {
        let segment = chunk_segment("  halo  ", 1200.0, 600.0, 1);
        assert_eq!(segment.id, "1-0");
        assert_eq!(segment.start_seconds, 1200.0);
        assert_eq!(segment.end_seconds, 1800.0);
        assert_eq!(segment.text, "halo");
    }

    #[test]
    fn joins_segments_and_drops_empty_ones() {
        let segments = vec![
            chunk_segment("first", 0.0, 10.0, 0),
            chunk_segment("   ", 10.0, 10.0, 1),
            chunk_segment("second", 20.0, 10.0, 2),
        ];
        assert_eq!(join_segments(&segments), "first\n\nsecond");
    }

    #[test]
    fn formats_timestamps_with_and_without_milliseconds() {
        assert_eq!(format_timestamp(3661.5, true), "01:01:01.500");
        assert_eq!(format_timestamp(3661.5, false), "01:01:01");
        // Negative input clamps rather than producing a nonsense timestamp.
        assert_eq!(format_timestamp(-5.0, true), "00:00:00.000");
    }
}
