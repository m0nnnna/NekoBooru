"""Semantic-prompt building, semantic output parsing, and tag merging/normalisation helpers."""
from __future__ import annotations

import json
import re
from collections import Counter
from pathlib import Path
from typing import Any

from .core import (
    AutoTagOptions,
    AutoTagResult,
    DEFAULT_NOISY_TAGS,
    DEFAULT_SEMANTIC_PROMPT,
    LEGACY_SEMANTIC_PROMPTS,
    MEDIA_TYPE_TAGS,
    normalize_tag,
    safety_from_rating,
)


def _clean_semantic_prompt(value: Any) -> str:
    prompt = str(value or "").strip()
    if not prompt:
        return DEFAULT_SEMANTIC_PROMPT
    if prompt in LEGACY_SEMANTIC_PROMPTS:
        return DEFAULT_SEMANTIC_PROMPT
    return prompt[:4000]


def _semantic_prompt(opts: AutoTagOptions) -> str:
    if not opts.semanticPromptEnabled:
        return DEFAULT_SEMANTIC_PROMPT
    return _clean_semantic_prompt(opts.semanticPrompt)


def _semantic_tag_limit(opts: AutoTagOptions) -> int:
    return max(1, min(int(opts.maxTags or 28), 60))


def _semantic_prompt_with_context(opts: AutoTagOptions, context: dict | None = None) -> str:
    prompt = _semantic_prompt(opts)
    if isinstance(context, dict) and context.get("mediaType") == "video":
        prompt += (
            "\n\nVideo input instruction:\n"
            "You are an expert video analysis model. The visual input represents a temporal video sequence, even if the "
            "runtime transports sampled frames internally. Analyze continuity, repeated actions, pose changes, and scene "
            "changes across time, but keep the output JSON schema unchanged. Focus on the important visible content: how "
            "the person or main subject looks, body/face/hair/eye attributes, clothing garments and materials, pose/action, "
            "setting, objects, text, and anything visually distinctive. Describe the media as a video or content, not as frames. "
            "For lewd, sketchy, unsafe, or nsfw video, explain exactly what is lewd: visible or emphasized body parts, "
            "nudity or partial nudity, transparent/tight/revealing garments, lingerie, swimwear, cleavage, underboob, "
            "sideboob, framing, explicit acts, and why the safety rating was selected. Do not rely only on suggestive pose. "
            "Do not describe the input as a grid, collage, contact sheet, slideshow, collection of images, "
            "series of frames, or frame set. Do not mention frame counts, timestamps, sampling, frame layout, or processor "
            "mechanics in tags or rationale."
        )
    compact = _compact_semantic_context(context)
    if compact:
        prompt += (
            "\n\nModel tag hints:\n"
            "Use these prior tagger results as visual grounding. They may contain noise, but if a specific animal type, "
            "ear, horn, tail, garment, clothing, color, pose, or visible object tag agrees with the image, prefer it over a generic guess. "
            "Do not use these hints to guess named characters, franchises, copyright/source tags, or identities.\n"
            f"{json.dumps(compact, ensure_ascii=False)}"
        )
    return prompt


def _compact_semantic_context(context: dict | None) -> dict:
    if not isinstance(context, dict):
        return {}
    compact: dict[str, Any] = {}
    hints = context.get("visualTagHints")
    if isinstance(hints, dict):
        visual = {
            "tags": _dedupe_tags(hints.get("tags") or [])[:40],
            "models": _dedupe_plain_strings(hints.get("models") or [])[:8],
        }
        visual = {key: value for key, value in visual.items() if value}
        if visual:
            compact["visualTagHints"] = visual
    if context.get("ocrText"):
        compact["ocrText"] = str(context.get("ocrText"))[:500]
    if context.get("transcript"):
        compact["transcript"] = str(context.get("transcript"))[:800]
    return compact


def _sanitize_qwen_semantic_payload(parsed: dict, context: dict | None = None) -> dict:
    if not isinstance(parsed, dict):
        return parsed
    blocked = _semantic_identity_hint_tags(context)
    tags = [normalize_tag(tag) for tag in parsed.get("tags", []) if normalize_tag(tag)]
    tags = [tag for tag in tags if tag not in blocked and not _is_frame_metadata_tag(tag)]
    parsed["tags"] = _dedupe_tags(tags)
    for key in ("rationale", "description", "summary"):
        if parsed.get(key):
            parsed[key] = _sanitize_semantic_rationale(str(parsed.get(key) or ""), blocked)
    return parsed


def _compact_semantic_raw_output(raw: str, parsed: dict) -> str:
    text = str(raw or "").strip()
    if not text:
        return text
    if len(text) <= 1400 and not _semantic_raw_is_repetitive(text):
        return text
    compact: dict[str, Any] = {
        "tags": [tag for tag in (parsed.get("tags") or []) if tag][:40],
    }
    safety = normalize_safety_label(parsed.get("safety"))
    if safety:
        compact["safety"] = safety
    rationale = str(
        parsed.get("rationale")
        or parsed.get("description")
        or parsed.get("summary")
        or ""
    ).strip()
    if rationale:
        compact["rationale"] = rationale[:900]
    else:
        compact["rationale"] = "Model output was compacted because it repeated tags or exceeded the preview limit."
    compact["compacted"] = True
    return json.dumps(compact, ensure_ascii=False)


def _semantic_raw_is_repetitive(text: str) -> bool:
    tags = [normalize_tag(value) for value in re.findall(r'"((?:\\.|[^"\\])*)"', str(text or ""))]
    tags = [tag for tag in tags if tag]
    if len(tags) < 40:
        return False
    unique = set(tags)
    if len(unique) / max(1, len(tags)) < 0.55:
        return True
    counts = Counter(tags)
    return any(count >= 8 for count in counts.values())


def _semantic_identity_hint_tags(context: dict | None) -> set[str]:
    if not isinstance(context, dict):
        return set()
    hints = context.get("visualTagHints")
    if not isinstance(hints, dict):
        return set()
    blocked = set()
    for key in ("characterTags", "copyrightTags"):
        for tag in hints.get(key) or []:
            norm = normalize_tag(tag)
            if norm:
                blocked.add(norm)
    return blocked


def _sanitize_semantic_rationale(text: str, blocked_tags: set[str] | None = None) -> str:
    out = str(text or "").strip()
    if not out:
        return out
    out = re.sub(
        r"\b(?:shown|depicted|presented)\s+in\s+a\s+series\s+of\s+frames\b",
        "shown in the video",
        out,
        flags=re.IGNORECASE,
    )
    out = re.sub(
        r"\b(?:the\s+)?video\s+frames?\s+(?:show|shows|depict|depicts)\b",
        "the video shows",
        out,
        flags=re.IGNORECASE,
    )
    out = re.sub(
        r"\bthe\s+(?:sampled\s+)?frames?\s+(?:show|shows|depict|depicts)\b",
        "the video shows",
        out,
        flags=re.IGNORECASE,
    )
    out = re.sub(
        r"\bacross\s+(?:the\s+)?(?:sampled\s+)?frames?\b",
        "throughout the video",
        out,
        flags=re.IGNORECASE,
    )
    out = re.sub(
        r"\bin\s+(?:the\s+)?(?:sampled\s+)?frames?\b",
        "in the video",
        out,
        flags=re.IGNORECASE,
    )
    out = re.sub(
        r"\b(?:the\s+)?(?:image|video|content)\s+(?:consists\s+of|contains|shows)\s+"
        r"(?:one|two|three|four|five|six|seven|eight|\d+)\s+(?:sampled\s+)?frames?\s+(?:showing|of)\b",
        "The video shows",
        out,
        flags=re.IGNORECASE,
    )
    out = re.sub(
        r"\b(?:the\s+)?(?:image|video|content)\s+is\s+(?:a\s+)?(?:series|grid|contact\s*sheet|compilation)\s+of\s+"
        r"(?:one|two|three|four|five|six|seven|eight|\d+)\s+(?:sampled\s+)?frames?\s+(?:showing|of)\b",
        "The video shows",
        out,
        flags=re.IGNORECASE,
    )
    out = re.sub(
        r"\b(?:the\s+)?(?:image|content)\s+is\s+a\s+(?:grid|collage|collection|set)\s+of\s+",
        "The video shows ",
        out,
        flags=re.IGNORECASE,
    )
    out = re.sub(
        r"\b(?:the\s+)?(?:image|content)\s+is\s+presented\s+as\s+(?:a\s+)?(?:grid|collage|collection|set)\s+of\s+[^.?!]+[.?!]\s*",
        "",
        out,
        flags=re.IGNORECASE,
    )
    out = re.sub(
        r"\b(?:across|in)\s+(?:the\s+)?(?:one|two|three|four|five|six|seven|eight|\d+)\s+(?:sampled\s+)?frames?\b",
        "in the video",
        out,
        flags=re.IGNORECASE,
    )
    sentences = re.split(r"(?<=[.!?])\s+", out)
    blocked_labels = {tag.replace("_", " ") for tag in (blocked_tags or set())}
    filtered = []
    identity_pattern = re.compile(
        r"\b(?:identified\s+as|character\s+is\s+identified|identity\s+is|franchise\s+is|copyright\s+is)\b",
        flags=re.IGNORECASE,
    )
    for sentence in sentences:
        lower = sentence.lower()
        if identity_pattern.search(sentence):
            continue
        if any(
            marker in lower
            for marker in (
                "frames are arranged",
                "arranged in a grid",
                "contact sheet",
                "sampled frame",
                "sampled frames",
                "frame labels",
                "series of frames",
                "frame set",
                "frame layout",
                "timestamp",
                "timestamps",
                "grid format",
                "slideshow format",
                "grid of",
                "collage of",
                "collection of selfies",
            )
        ):
            continue
        if blocked_labels and any(label and label in lower for label in blocked_labels):
            continue
        filtered.append(sentence)
    out = " ".join(part.strip() for part in filtered if part.strip())
    return re.sub(r"\s+", " ", out).strip()


def _add_visual_tag_hints(context: dict | None, results: list[AutoTagResult]) -> None:
    if context is None:
        return
    hints = context.setdefault("visualTagHints", {"tags": [], "characterTags": [], "copyrightTags": [], "models": []})
    if not isinstance(hints, dict):
        return
    for result in results:
        if not result or result.error:
            continue
        hints.setdefault("tags", []).extend(result.tags)
        hints.setdefault("characterTags", []).extend(result.character_tags)
        hints.setdefault("copyrightTags", []).extend(result.copyright_tags)
        if result.model:
            hints.setdefault("models", []).append(result.model)
    hints["tags"] = _dedupe_tags(hints.get("tags") or [])[:60]
    hints["characterTags"] = _dedupe_tags(hints.get("characterTags") or [])[:30]
    hints["copyrightTags"] = _dedupe_tags(hints.get("copyrightTags") or [])[:30]
    hints["models"] = _dedupe_plain_strings(hints.get("models") or [])[:10]


def _dedupe_plain_strings(values: list[Any]) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for value in values:
        item = str(value or "").strip()
        if item and item not in seen:
            seen.add(item)
            out.append(item)
    return out


def merge_with_existing(existing: list[str], result: AutoTagResult, opts: AutoTagOptions) -> tuple[list[str], dict[str, str]]:
    excluded = _excluded_tags(opts)
    raw = list(existing or [])
    raw.extend(result.all_tags)
    if opts.addProvenanceTag and result.all_tags:
        raw.append(opts.provenanceTag)

    seen: set[str] = set()
    out: list[str] = []
    categories = dict(result.categories)
    if opts.addProvenanceTag and result.all_tags:
        categories[normalize_tag(opts.provenanceTag)] = "meta"
    for tag in (normalize_tag(t) for t in raw):
        if tag and tag not in excluded and tag not in seen:
            seen.add(tag)
            out.append(tag)
    categories = {tag: category for tag, category in categories.items() if normalize_tag(tag) in seen}
    return out, categories


def promote_safety(current: str, suggested: str | None, opts: AutoTagOptions) -> str:
    suggested = normalize_safety_label(suggested)
    if not opts.applySafety or not suggested:
        return current
    rank = {"safe": 0, "sketchy": 1, "unsafe": 2}
    if opts.neverDowngradeSafety and rank.get(suggested, 0) < rank.get(current, 0):
        return current
    return suggested if rank.get(suggested, 0) > rank.get(current, 0) else current


def normalize_safety_label(value: Any) -> str | None:
    label = normalize_tag(str(value or ""))
    if not label:
        return None
    if label in {"safe", "general", "sfw"}:
        return "safe"
    if label in {
        "sketchy",
        "questionable",
        "sensitive",
        "suggestive",
        "sexually_suggestive",
        "partial_nudity",
        "partial_nude",
        "revealing",
    }:
        return "sketchy"
    if label in {
        "unsafe",
        "explicit",
        "nsfw",
        "nude",
        "nudity",
        "naked",
        "sexual",
        "porn",
        "pornographic",
        "adult",
        "adult_erotic",
        "explicit_sexual",
        "explicit_nsfw_content",
    }:
        return "unsafe"
    return None


def _dedupe_tags(tags: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for tag in tags:
        norm = normalize_tag(tag)
        if norm and not _is_frame_metadata_tag(norm) and norm not in seen:
            seen.add(norm)
            out.append(norm)
    return out


def _is_frame_metadata_tag(tag: str) -> bool:
    normalized = normalize_tag(tag)
    if normalized in {"frame", "frames", "sampled_frame", "sampled_frames", "timestamp", "timestamps", "grid", "collage", "contact_sheet", "photo_collage", "image_grid"}:
        return True
    if re.fullmatch(r"frame_\d+", normalized):
        return True
    if re.fullmatch(r"\d+_frames?", normalized):
        return True
    if re.fullmatch(r"(?:one|two|three|four|five|six|seven|eight)_frames?", normalized):
        return True
    if re.fullmatch(r"t_\d+(?:[._]\d+)?s?", normalized):
        return True
    return False


def _excluded_tags(opts: AutoTagOptions) -> set[str]:
    return {normalize_tag(t) for t in [*DEFAULT_NOISY_TAGS, *(opts.excludedTags or [])] if normalize_tag(t)}


def _media_type_tag(path: Path) -> str | None:
    return MEDIA_TYPE_TAGS.get(Path(path).suffix.lower())


def _append_media_type_tag(result: AutoTagResult, path: Path) -> None:
    tag = _media_type_tag(path)
    if not tag:
        return
    result.tags.append(tag)
    result.categories[normalize_tag(tag)] = "meta"


def _apply_tag_filters(result: AutoTagResult, opts: AutoTagOptions) -> AutoTagResult:
    excluded = _excluded_tags(opts)
    result.tags = [tag for tag in _dedupe_tags(result.tags) if tag not in excluded]
    result.character_tags = [tag for tag in _dedupe_tags(result.character_tags) if tag not in excluded]
    result.copyright_tags = [tag for tag in _dedupe_tags(result.copyright_tags) if tag not in excluded]
    allowed = set(result.all_tags)
    result.categories = {
        normalize_tag(tag): category
        for tag, category in result.categories.items()
        if normalize_tag(tag) in allowed
    }
    return result


def _higher_safety(left: str | None, right: str | None) -> str | None:
    rank = {"safe": 0, "sketchy": 1, "unsafe": 2}
    if not left:
        return right
    if not right:
        return left
    return right if rank.get(right, 0) > rank.get(left, 0) else left


def _camie_safety(rating: dict[str, float], opts: AutoTagOptions) -> str | None:
    normalized = {
        "explicit": max(rating.get("explicit", 0.0), rating.get("rating_explicit", 0.0)),
        "questionable": max(rating.get("questionable", 0.0), rating.get("rating_questionable", 0.0)),
        "sensitive": max(rating.get("sensitive", 0.0), rating.get("rating_sensitive", 0.0)),
        "general": max(rating.get("general", 0.0), rating.get("rating_general", 0.0)),
    }
    return safety_from_rating(normalized, opts)


def _looks_political(text: str) -> bool:
    haystack = str(text or "").lower()
    needles = [
        "president", "election", "vote", "democrat", "republican", "congress",
        "senate", "government", "politic", "campaign", "trump", "biden",
        "war", "protest", "propaganda", "minister", "parliament",
    ]
    return any(needle in haystack for needle in needles)


def _looks_like_music_transcript(text: str) -> bool:
    haystack = str(text or "").lower()
    if "♪" in haystack or "♫" in haystack:
        return True
    needles = [
        "[music]", "(music)", "background music", "song", "singing", "sings",
        "lyrics", "chorus", "verse", "instrumental", "melody", "beat drops",
    ]
    return any(needle in haystack for needle in needles)


def _whisper_tags_from_text(text: str) -> list[str]:
    tags = []
    if str(text or "").strip():
        tags.append("has_speech")
    if _looks_political(text):
        tags.append("political_audio")
    if _looks_like_music_transcript(text):
        tags.extend(["music", "edit"])
    return _dedupe_tags(tags)


def _meaningful_ocr_text(text: str) -> bool:
    normalized = re.sub(r"\s+", " ", str(text or "")).strip()
    alnum = re.findall(r"[a-zA-Z0-9]", normalized)
    if len(alnum) < 6:
        return False
    words = re.findall(r"[a-zA-Z0-9]{2,}", normalized)
    return len(words) >= 2 or len(alnum) >= 10


def _parse_semantic_json(raw: str) -> dict:
    text = str(raw or "").strip()
    match = re.search(r"\{.*\}", text, flags=re.DOTALL)
    if match:
        text = match.group(0)
    try:
        data = json.loads(text)
    except Exception:
        return _semantic_fallback_payload(raw)
    if not isinstance(data, dict):
        return _semantic_fallback_payload(raw)
    if not data.get("rationale") and data.get("description"):
        data["rationale"] = data.get("description")
    if not data.get("safety") and data.get("safety_classification"):
        safety = normalize_safety_label(data.get("safety_classification"))
        if safety:
            data["safety"] = safety
    tags = data.get("tags") or data.get("keywords") or data.get("search_tags") or []
    if isinstance(tags, str):
        tags = [tags]
    tags = tags if isinstance(tags, list) else []
    semantic_text = " ".join(
        str(value or "")
        for value in (
            raw,
            data.get("rationale"),
            data.get("description"),
            data.get("caption"),
            data.get("summary"),
            data.get("scene"),
            data.get("safety_reason"),
            data.get("raw"),
        )
    )
    if not tags:
        tags = _semantic_tags_from_text(semantic_text)
    tags = _dedupe_tags([
        *tags,
        *_semantic_pose_action_tags_from_text(semantic_text),
        *_semantic_symbol_tags_from_text(semantic_text),
    ])
    data["tags"] = tags
    return data


def _semantic_fallback_payload(raw: str) -> dict:
    tags = _dedupe_tags([
        *_semantic_tag_list_from_text(raw),
        *_semantic_tags_from_text(raw),
        *_semantic_symbol_tags_from_text(raw),
    ])
    payload = {"tags": tags, "raw": raw}
    safety = _semantic_safety_from_text(raw)
    if safety:
        payload["safety"] = safety
    return payload


def _semantic_tag_list_from_text(text: str) -> list[str]:
    match = re.search(r'"(?:tags|keywords|search_tags)"\s*:\s*\[([\s\S]*?)(?:\]|\n\s*"(?:safety|rationale|description|summary)"\s*:|$)', str(text or ""), flags=re.IGNORECASE)
    if not match:
        return []
    return [value for value in re.findall(r'"((?:\\.|[^"\\])*)"', match.group(1)) if value.strip()]


def _semantic_safety_from_text(text: str) -> str | None:
    match = re.search(r'"(?:safety|safety_classification)"\s*:\s*"([^"]+)"', str(text or ""), flags=re.IGNORECASE)
    return normalize_safety_label(match.group(1)) if match else None


def _semantic_symbol_tags_from_text(text: str) -> list[str]:
    haystack = str(text or "").lower()

    def present(pattern: str) -> bool:
        return re.search(pattern, haystack) is not None

    def negated(pattern: str) -> bool:
        return re.search(
            rf"\b(no|not|without|absent|none|no visible|not visible)\b[^.:\n]{{0,80}}{pattern}",
            haystack,
        ) is not None

    tags = []
    if present(r"\bswastikas?\b") and not negated(r"\bswastikas?\b"):
        tags.extend(["swastika", "national_socialism"])
    if present(r"\bsonnenrads?\b") and not negated(r"\bsonnenrads?\b"):
        tags.extend(["sonnenrad", "national_socialism"])
    if present(r"\bblack[_\s-]?suns?\b") and not negated(r"\bblack[_\s-]?suns?\b"):
        tags.extend(["black_sun", "national_socialism"])
    if present(r"\bhammer[_\s-]?and[_\s-]?sickles?\b") and not negated(r"\bhammer[_\s-]?and[_\s-]?sickles?\b"):
        tags.extend(["hammer_and_sickle", "communism"])
    if (
        present(r"\bcommunist\s+red\s+stars?\b")
        or (present(r"\bred\s+stars?\b") and present(r"\bcommunis[mt]\b"))
    ) and not negated(r"\b(red\s+stars?|communist\s+red\s+stars?)\b"):
        tags.extend(["communist_red_star", "communism"])
    return _dedupe_tags(tags)


def _semantic_pose_action_tags_from_text(text: str) -> list[str]:
    haystack = str(text or "").lower()
    candidates = {
        "lying": [
            r"\blying\b",
            r"\blying\s+(?:down|on|in)\b",
            r"\blaying\s+(?:down|on|in)\b",
            r"\breclining\b",
        ],
        "sitting": [r"\bsitting\b", r"\bseated\b"],
        "standing": [r"\bstanding\b"],
        "kneeling": [r"\bkneeling\b"],
        "crouching": [r"\bcrouching\b"],
        "squatting": [r"\bsquatting\b"],
        "walking": [r"\bwalking\b"],
        "running": [r"\brunning\b"],
        "jumping": [r"\bjumping\b"],
        "dancing": [r"\bdancing\b"],
        "sleeping": [r"\bsleeping\b", r"\basleep\b"],
        "stretching": [r"\bstretching\b"],
        "arms_up": [r"\barms?\s+(?:raised|up|overhead)\b", r"\braised\s+arms?\b"],
        "looking_at_viewer": [r"\blooking\s+at\s+(?:the\s+)?viewer\b"],
        "selfie": [r"\bselfie\b"],
    }
    tags = []
    for tag, patterns in candidates.items():
        if any(re.search(pattern, haystack) for pattern in patterns):
            tags.append(tag)
    return _dedupe_tags(tags)


def _semantic_tags_from_text(text: str) -> list[str]:
    haystack = str(text or "").lower()
    negated_political = any(
        phrase in haystack
        for phrase in (
            "no visible political",
            "no political",
            "no protest",
            "no propaganda",
            "no extremist",
            "without political",
            "without protest",
            "without propaganda",
        )
    )
    negative_context = any(
        phrase in haystack
        for phrase in (
            "no stronger context",
            "no indications of being",
            "no visible",
            "without any indications",
        )
    )
    candidates = {
        "person": ["person", "people", "man", "woman"],
        "woman": ["woman", "female"],
        "man": ["man", "male"],
        "photo": ["photo", "photograph", "realistic", "natural lighting"],
        "realistic": ["realistic", "photograph", "natural lighting"],
        "natural_lighting": ["natural lighting"],
        "indoors": ["indoors", "inside", "room"],
        "outdoors": ["outdoors", "outside", "street"],
        "bikini": ["bikini", "swimsuit"],
        "swimwear": ["bikini", "swimsuit", "swimwear"],
        "pink": ["pink"],
        "pink_clothing": ["pink bikini", "pink dress", "pink shirt", "pink clothing"],
        "patterned_clothing": ["patterned", "print", "strawberry patterns", "strawberry print"],
        "strawberry_print": ["strawberry patterns", "strawberry print"],
        "meme": ["meme"],
        "screenshot": ["screenshot"],
        "captioned": ["caption", "captioned", "subtitle", "text overlay"],
        "political_edit": ["political edit"],
        "meme_edit": ["meme edit"],
        "amv": ["amv"],
        "music_video": ["music video"],
        "propaganda": ["propaganda"],
        "protest": ["protest"],
    }
    tags = []
    for tag, needles in candidates.items():
        if negated_political and tag in {"political_edit", "propaganda", "protest"}:
            continue
        if negative_context and tag in {"meme_edit", "amv", "music_video"}:
            continue
        if any(_semantic_phrase_present(haystack, needle) for needle in needles):
            tags.append(tag)
    return tags[:10]


def _semantic_phrase_present(haystack: str, phrase: str) -> bool:
    words = [re.escape(part) for part in re.findall(r"[a-z0-9]+", str(phrase or "").lower())]
    if not words:
        return False
    separator = r"[\s_-]+"
    pattern = separator.join(words)
    return re.search(rf"(?<![a-z0-9]){pattern}(?![a-z0-9])", haystack) is not None
