use crate::types::Transcript;

pub fn to_text(transcript: &Transcript) -> String {
    transcript.text.clone()
}

pub fn to_markdown(transcript: &Transcript) -> String {
    format!(
        "# {}\n\n{}\n",
        transcript.title,
        transcript.summary.as_deref().unwrap_or("")
    )
}

/// Windows forbids these outright, and a control character in a Content-Disposition header is
/// worse than a wrong filename.
pub fn safe_filename(title: &str) -> String {
    let cleaned: String = title
        .chars()
        .map(|c| if (c as u32) < 32 { '_' } else { c })
        .map(|c| if r#"<>:"/\|?*"#.contains(c) { '_' } else { c })
        .take(100)
        .collect();
    if cleaned.trim().is_empty() {
        "transcript".to_string()
    } else {
        cleaned
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_characters_that_cannot_appear_in_a_filename() {
        assert_eq!(safe_filename("Rapat: Q1/Q2 <draft>"), "Rapat_ Q1_Q2 _draft_");
        assert_eq!(safe_filename("   "), "transcript");
        assert_eq!(safe_filename(""), "transcript");
        assert_eq!(safe_filename("line\nbreak"), "line_break");
    }
}
