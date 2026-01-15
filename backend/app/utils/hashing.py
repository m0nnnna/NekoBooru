import hashlib
from pathlib import Path


def calculate_sha256(file_path: Path) -> str:
    """Calculate SHA256 hash of a file."""
    sha256_hash = hashlib.sha256()
    with open(file_path, "rb") as f:
        for byte_block in iter(lambda: f.read(4096), b""):
            sha256_hash.update(byte_block)
    return sha256_hash.hexdigest()


def calculate_sha256_from_bytes(data: bytes) -> str:
    """Calculate SHA256 hash from bytes."""
    return hashlib.sha256(data).hexdigest()
