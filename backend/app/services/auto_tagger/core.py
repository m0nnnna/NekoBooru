"""Model ids, the model registry, and the option/result dataclasses every auto-tagger part shares."""
from __future__ import annotations

import re
import threading
from dataclasses import dataclass, field


SUPPORTED_IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".gif"}
SUPPORTED_VIDEO_EXTS = {".webm", ".mp4"}
WD_MODEL_ID = "SmilingWolf/wd-eva02-large-tagger-v3"
# CL Tagger v2 ships one subfolder per checkpoint; pin the version we support so
# downloads stay small and the vocabulary always matches the ONNX graph.
CL_MODEL_ID = "cella110n/cl_tagger_v2"
CL_MODEL_VERSION = "v2_01a"
CL_ONNX_FILE = f"{CL_MODEL_VERSION}/model.onnx"
CL_ONNX_DATA_FILE = f"{CL_MODEL_VERSION}/model.onnx.data"
CL_VOCAB_FILE = f"{CL_MODEL_VERSION}/model_vocabulary.json"
CL_METADATA_FILE = f"{CL_MODEL_VERSION}/model_metadata.json"
CL_IMAGE_SIZE = 384
# The model card recommends 0.55 for practical tagging; the per-tag best_thr
# table maximizes F1 but over-tags badly across a 108k-tag vocabulary.
CL_MIN_THRESHOLD = 0.55
CL_RATING_WORDS = {"general", "sensitive", "questionable", "explicit"}
CL_QUALITY_WORDS = {"best quality", "normal quality", "bad quality", "worst quality", "best", "normal", "bad", "worst"}
WHISPER_MAX_AUDIO_SECONDS = 30
QWEN_MIN_FREE_VRAM_GB = 18.0
QWEN_ANALYSIS_MAX_SIDE = 900
QWEN_VIDEO_FPS = 2.0
QWEN_MAX_NEW_TOKENS = 512
QWEN_GGUF_MAX_TOKENS = 512
QWEN_GGUF_REPO_ID = "Qwen/Qwen3-VL-8B-Instruct-GGUF"
QWEN_GGUF_MMPROJ_FILE = "mmproj-Qwen3VL-8B-Instruct-F16.gguf"
QWEN_GGUF_FILE_SIZES = {
    "Qwen3VL-8B-Instruct-Q4_K_M.gguf": 5_027_784_800,
    "Qwen3VL-8B-Instruct-Q8_0.gguf": 8_709_519_456,
    "mmproj-Qwen3VL-8B-Instruct-F16.gguf": 1_159_029_824,
}
QWEN_SEMANTIC_MODEL_IDS = {"qwen", "qwen_gguf_q4", "qwen_gguf_q8"}
MEDIA_TYPE_TAGS = {
    ".jpg": "image",
    ".jpeg": "image",
    ".png": "image",
    ".webp": "image",
    ".gif": "gif",
    ".mp4": "video",
    ".webm": "video",
}
DEFAULT_NOISY_TAGS = {
    "absurdres",
    "best_quality",
    "card_medium",
    "commentary_request",
    "compression_artifacts",
    "high_quality",
    "highres",
    "jpeg_artifacts",
    "low_quality",
    "lowres",
    "medium_quality",
    "outline",
    "signature",
    "text_focus",
    "thumbnail",
    "transparent_background",
    "twitter_username",
    "username",
    "watermark",
    "worst_quality",
}

MODEL_REGISTRY = {
    "wd": {
        "id": "wd",
        "name": "WD Tagger",
        "repoId": WD_MODEL_ID,
        "purpose": "Booru-style image and sampled video-frame tags",
        "downloadSize": "~1.2 GB",
        "vramRequirement": "~0.5-1.5 GB",
        "status": "tagging_ready",
        "allowPatterns": ["model.onnx", "selected_tags.csv"],
    },
    "pixai": {
        "id": "pixai",
        "name": "PixAI Tagger v0.9",
        "repoId": "deepghs/pixai-tagger-v0.9-onnx",
        "purpose": "Fast Danbooru-style anime/illustration tags from PixAI Tagger v0.9",
        "downloadSize": "~1.3 GB",
        "vramRequirement": "~0.5-1.5 GB",
        "status": "tagging_ready",
        "allowPatterns": None,
        "requiredFileKinds": ["onnx", "tags"],
        "expectedTotalBytes": 1_272_005_678,
        "characterThreshold": 0.85,
    },
    "camie": {
        "id": "camie",
        "name": "Camie Tagger v2",
        "repoId": "Camais03/camie-tagger-v2",
        "purpose": "Anime character, copyright, artist, rating, and broad tag coverage",
        "downloadSize": "~1-3 GB",
        "vramRequirement": "~0.5-2 GB",
        "status": "tagging_ready",
        "allowPatterns": None,
        "requiredFiles": ["camie-tagger-v2.onnx", "camie-tagger-v2-metadata.json"],
    },
    "cl": {
        "id": "cl",
        "name": "CL Tagger v2",
        "repoId": CL_MODEL_ID,
        "purpose": "SigLIP2 Danbooru tagger with a 108k-tag character/copyright/general vocabulary",
        "downloadSize": "~2.3 GB",
        "vramRequirement": "~2-3 GB",
        "status": "tagging_ready",
        "version": CL_MODEL_VERSION,
        # Gated repo (auto-approved): the user has to accept the license on the
        # model page once and save a Hugging Face token before downloading.
        "gated": True,
        "gatedUrl": f"https://huggingface.co/{CL_MODEL_ID}",
        # Large and gated, so keep it out of "Download all" — it would fail the
        # whole batch for anyone who has not accepted the license yet.
        "downloadAll": False,
        "allowPatterns": [CL_ONNX_FILE, CL_ONNX_DATA_FILE, CL_VOCAB_FILE, CL_METADATA_FILE],
        "requiredFiles": [CL_ONNX_FILE, CL_ONNX_DATA_FILE, CL_VOCAB_FILE],
        "expectedTotalBytes": 2_227_031_325,
        "generalThreshold": CL_MIN_THRESHOLD,
        "characterThreshold": CL_MIN_THRESHOLD,
    },
    "qwen": {
        "id": "qwen",
        "name": "Qwen2.5-VL 7B Instruct",
        "repoId": "Qwen/Qwen2.5-VL-7B-Instruct",
        "purpose": "Semantic video/edit understanding, political context, and natural-language evidence",
        "downloadSize": "~15-17 GB",
        "vramRequirement": "~14-18 GB fp16, 24 GB comfortable",
        "status": "tagging_ready",
        "role": "semantic",
        "backend": "transformers",
        "downloadAll": True,
        "allowPatterns": None,
        "requiredFiles": ["config.json"],
    },
    "qwen_gguf_q4": {
        "id": "qwen_gguf_q4",
        "name": "Qwen3-VL 8B GGUF Q4",
        "repoId": QWEN_GGUF_REPO_ID,
        "purpose": "Fast local semantic image/video-frame understanding through llama.cpp GGUF",
        "downloadSize": "~6.4 GB",
        "vramRequirement": "~6-8 GB, 8-12 GB comfortable",
        "status": "tagging_ready",
        "role": "semantic",
        "backend": "gguf",
        "quantization": "Q4_K_M",
        "downloadAll": False,
        "storage": "local_files",
        "allowPatterns": ["Qwen3VL-8B-Instruct-Q4_K_M.gguf", QWEN_GGUF_MMPROJ_FILE],
        "requiredFiles": ["Qwen3VL-8B-Instruct-Q4_K_M.gguf", QWEN_GGUF_MMPROJ_FILE],
        "fileSizes": QWEN_GGUF_FILE_SIZES,
    },
    "qwen_gguf_q8": {
        "id": "qwen_gguf_q8",
        "name": "Qwen3-VL 8B GGUF Q8",
        "repoId": QWEN_GGUF_REPO_ID,
        "purpose": "Higher-quality local semantic image/video-frame understanding through llama.cpp GGUF",
        "downloadSize": "~10.0 GB",
        "vramRequirement": "~10-12 GB, 12-16 GB comfortable",
        "status": "tagging_ready",
        "role": "semantic",
        "backend": "gguf",
        "quantization": "Q8_0",
        "downloadAll": False,
        "storage": "local_files",
        "allowPatterns": ["Qwen3VL-8B-Instruct-Q8_0.gguf", QWEN_GGUF_MMPROJ_FILE],
        "requiredFiles": ["Qwen3VL-8B-Instruct-Q8_0.gguf", QWEN_GGUF_MMPROJ_FILE],
        "fileSizes": QWEN_GGUF_FILE_SIZES,
    },
    "ocr": {
        "id": "ocr",
        "name": "TrOCR Printed",
        "repoId": "microsoft/trocr-base-printed",
        "purpose": "Text extraction from meme/edit frames and subtitles",
        "downloadSize": "~1.3 GB",
        "vramRequirement": "~1-2 GB",
        "status": "tagging_ready",
        "allowPatterns": None,
        "requiredFiles": ["config.json", "model.safetensors", "preprocessor_config.json"],
    },
    "whisper": {
        "id": "whisper",
        "name": "Whisper Small",
        "repoId": "openai/whisper-small",
        "purpose": "Speech/audio transcript signals for AMVs and edits",
        "downloadSize": "~1 GB",
        "vramRequirement": "~1-2 GB",
        "status": "tagging_ready",
        "allowPatterns": None,
        "requiredFiles": ["config.json"],
    },
}


# Serializes everything that touches the GPU: inference and model loads/unloads.
# Without it a bulk tag run and a "Load model" click allocate VRAM at the same
# time and the process dies on an out-of-memory error mid-job. Held per media
# item rather than per job so a queued load still gets a turn promptly.
_gpu_work_lock = threading.RLock()


DEFAULT_SEMANTIC_PROMPT = (
    "Return compact JSON with keys: tags, safety, rationale, safety_reason, confidence.\n"
    "Use snake_case tags only.\n\n"
    "Semantic description:\n"
    "- The rationale should be a direct factual caption of the visible content. Describe clothing garments, pose, setting, text, and audio/transcript evidence. When describing adult or NSFW visual content, respond plainly with a clear safety classification. If the content is erotic or sexually suggestive, say so plainly and explain why. Do not euphemize visible adult content, but do not invent details that are not visible. If lewd, sketchy, unsafe, or nsfw, explain the concrete visual reason: visible or emphasized body parts, nudity or partial nudity, transparent/tight/revealing garments, lingerie, swimwear, cleavage, underboob, sideboob, pose, framing, explicit acts, and why the safety rating was selected. Do not rely only on suggestive pose. Do not mention sampled frame counts, frame labels, contact sheets, timestamps, or model sampling mechanics.\n\n"
    "Example expected rationale style:\n"
    "\"A single woman with long black hair and brown eyes is shown in a video. She wears a white lace bra and matching panties, revealing her breasts and cleavage. She smiles at the camera while sitting indoors, sometimes touching her head or hair, occasionally resting her hand on her chest or stomach. The setting appears to be an indoor room with soft lighting. Visible details include a mole under her mouth, bare shoulders, and her navel. The content is explicitly erotic due to the revealing lingerie, prominent cleavage, and suggestive poses.\"\n\n"
    "Safety values:\n"
    "- Use safety safe for ordinary SFW content, sketchy for suggestive/revealing content, and unsafe for explicit NSFW/adult erotic content. safety_reason should briefly explain the classification based only on visible evidence. confidence must be low, medium, or high.\n\n"
    "Tags in priority order:\n"
    "- Return 6-28 useful searchable tags supported by the image, frame, OCR, transcript, or source page.\n"
    "- For video frame collections or contact sheets, compare the sampled frames in order and infer temporal context, but describe it as the video/content, and do not output metadata tags or mention metadata such as frame_1, frame_2, three_frames, timestamps, contact_sheet, or sampled_frame.\n"
    "- When model tag hints are provided, use only their visual tags as grounding. Prefer specific animal type, ear, horn, tail, and clothing hints unless the image clearly contradicts them. Do not output named character, franchise, copyright, or source tags, and do not mention guessed identities in the rationale.\n"
    "- Start with directly visible tags: media type, exact pose/action, subject count, male/female/girl/boy, setting, objects, actions, expression, hair color, eye color, framing, text/audio presence, and meme/edit format.\n"
    "- Always include the main visible pose or action as a searchable tag when clear, such as lying, sitting, standing, kneeling, crouching, squatting, walking, running, jumping, dancing, sleeping, stretching, arms_up, looking_at_viewer, or selfie.\n"
    "- Decompose clothing into specific garments and attributes. Name the garment type separately from pattern or theme. Example cow_print_outfit, bikini, swimsuit, would all be included.\n"
    "- Do not confuse animal ears types or horns for clothing, or horns for ears. Tag what is visibly present, such as animal_ears, cow_horns, white_horns, tail, or cow_tail.\n"
    "- Add frequent or matching primary colors for the scene or clothing, hair color, eye color, standout accessories, exact pose, and anything visually distinctive.\n"
    "- Include screenshot, photo, video, image, or gif when they fit.\n"
    "- If lewd or nsfw explain what is erotic about it with concrete visible evidence, not only pose.\n"
    "- Add semantic/context tags only when supported: political_edit, meme_edit, amv, music_video, captioned, protest, politician, propaganda, music, edit, has_text, text_overlay, has_speech, swastika, sonnenrad, black_sun, national_socialism, hammer_and_sickle, communism."
)
LEGACY_SEMANTIC_PROMPTS = {
    (
        "Return compact JSON only with keys tags, safety, rationale. "
        "Use snake_case tags. Look for higher-level context such as political_edit, meme_edit, amv, music_video, "
        "captioned, protest, politician, propaganda, and contextual edit signals only when visually or transcript supported. "
        "Use national_socialism only for clear Nazi/far-right symbols such as a swastika, sonnenrad, or black_sun. "
        "Use communism only for clear communist symbols such as a hammer_and_sickle or communist red star. "
        "If transcript or audio evidence suggests a song or music-driven edit, include music and edit."
    ),
    "Return JSON semantic tags.",
}


@dataclass
class AutoTagOptions:
    enabled: bool = False
    tagNewUploads: bool = False
    tagNewImports: bool = False
    tagImages: bool = True
    tagVideos: bool = True
    wdEnabled: bool = True
    pixaiEnabled: bool = False
    clEnabled: bool = False
    # Ask a public booru for a character's series at tag time. The model's
    # character head is far more reliable than its copyright head, so this fills
    # in copyrights it missed. Off by default: it makes network calls.
    booruLookupEnabled: bool = False
    # Offer tag-name completions from public boorus while typing, for tags this
    # library does not have yet. Off by default: it sends the partial tag you
    # are typing to a third party.
    booruSuggestEnabled: bool = False
    generalThreshold: float = 0.35
    characterThreshold: float = 0.45
    maxTags: int = 40
    addProvenanceTag: bool = True
    provenanceTag: str = "auto_tagged"
    applySafety: bool = True
    unsafeThreshold: float = 0.70
    sketchyThreshold: float = 0.65
    neverDowngradeSafety: bool = True
    defaultBackfillMode: str = "lightly_tagged"
    lightlyTaggedMaxTags: int = 2
    mergeMode: str = "append_new"
    previewByDefault: bool = True
    videoFrameStrategy: str = "multi"
    videoMaxFrames: int = 4
    # Seconds into the video to analyse, chosen by the user scrubbing the
    # preview. None keeps the automatic sampling. A pinned frame beats any
    # sampling heuristic when the shot that identifies the subject is not where
    # the sampler happens to look.
    videoFrameTime: float | None = None
    qwenVideoUseFps: bool = False
    qwenVideoMaxFrames: int = 20
    videoMaxDurationSeconds: int = 900
    semanticPoliticalEnabled: bool = False
    semanticPrompt: str = DEFAULT_SEMANTIC_PROMPT
    ocrEnabled: bool = False
    whisperEnabled: bool = False
    qwenEnabled: bool = False
    semanticModelId: str = "qwen"
    semanticPromptEnabled: bool = True
    semanticSearchEnabled: bool = False
    saveSemanticAnalysis: bool = False
    characterModelEnabled: bool = False
    torchDevice: str = "auto"
    # Offload inference to a remote GPU worker (another NekoBooru instance with
    # the AI stack installed). When enabled, tag_media() forwards media to the
    # worker's /api/auto-tags/infer instead of running models in this process.
    remoteEnabled: bool = False
    remoteUrl: str = ""
    remoteTimeoutSeconds: int = 120
    excludedTags: list[str] = field(default_factory=list)
    keywordRules: list[dict] = field(default_factory=list)
    inheritSimilarTags: bool = True
    inheritSimilarMaxDistance: int = 8
    inheritSimilarMinTags: int = 1


@dataclass
class AutoTagResult:
    tags: list[str] = field(default_factory=list)
    character_tags: list[str] = field(default_factory=list)
    copyright_tags: list[str] = field(default_factory=list)
    rating: dict[str, float] = field(default_factory=dict)
    safety: str | None = None
    categories: dict[str, str] = field(default_factory=dict)
    # normalized tag -> the model's own spelling, e.g.
    # "miyu_blue_archive" -> "miyu (blue archive)". Display only.
    display_names: dict[str, str] = field(default_factory=dict)
    evidence: dict = field(default_factory=dict)
    model: str = ""
    enabled: bool = False
    error: str | None = None
    duration_ms: int = 0

    @property
    def all_tags(self) -> list[str]:
        raw = [*self.tags, *self.character_tags, *self.copyright_tags]
        seen: set[str] = set()
        out: list[str] = []
        for tag in raw:
            norm = normalize_tag(tag)
            if norm and norm not in seen:
                seen.add(norm)
                out.append(norm)
        return out


def normalize_tag(raw: str) -> str:
    tag = str(raw or "").strip().lower().replace(" ", "_")
    tag = re.sub(r"[^\w:.-]+", "_", tag)
    tag = re.sub(r"_+", "_", tag)
    return tag.strip("_")


def qualified_display_name(raw: str) -> str | None:
    """The readable spelling of a tagger vocabulary name, or None if it has none.

    Every tagger vocabulary here is Danbooru-shaped: ``nami_(one_piece)``, which
    normalize_tag() flattens to ``nami_one_piece``. That flattening is what makes
    both spellings find each other in search, but it drops the qualifier's
    parentheses, and the UI's fallback (underscores become spaces) cannot put
    them back. Keep them for qualified names only - a plain tag's fallback
    already reads correctly, so storing one for it is noise.

    Mirrors services/tagging.qualifier_display_name, which does the same for
    hand-typed and imported tags; this module deliberately stays free of the DB
    layer, the way it already keeps its own copy of normalize_tag().
    """
    text = re.sub(r"\s+", " ", str(raw or "").strip().lower())
    if "(" not in text or ")" not in text:
        return None
    return text.replace("_", " ").strip()


def safety_from_rating(rating: dict[str, float], opts: AutoTagOptions) -> str | None:
    explicit = max(rating.get("explicit", 0.0), rating.get("rating_explicit", 0.0))
    questionable = max(rating.get("questionable", 0.0), rating.get("rating_questionable", 0.0))
    sensitive = max(rating.get("sensitive", 0.0), rating.get("sensitive_content", 0.0))
    if explicit >= opts.unsafeThreshold:
        return "unsafe"
    sketchy_threshold = max(opts.sketchyThreshold, 0.65)
    if (
        explicit >= sketchy_threshold
        or questionable >= max(opts.unsafeThreshold, 0.75)
        or sensitive >= max(sketchy_threshold, 0.75)
    ):
        return "sketchy"
    if rating:
        return "safe"
    return None
