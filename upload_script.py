"""
NekoBooru Upload Script
Compatible with your existing szurubooru workflow.
Place tag files alongside images (image.txt or image.jpg.txt)
"""

import requests
import os
import sys
import time
import logging
from pathlib import Path

# Setup logging
logging.basicConfig(
    filename='upload_script.log',
    level=logging.INFO,
    format='%(asctime)s - %(message)s'
)

# Configuration - UPDATE THIS
API_URL = "http://localhost:8000"  # NekoBooru server
UPLOAD_DIR = ""  # Set your upload directory

# Session setup (no auth needed for single-user mode)
session = requests.Session()
session.headers = {
    "Accept": "application/json",
}

LOG_FILE_PATH = Path(UPLOAD_DIR) / "processed_files.txt" if UPLOAD_DIR else None


def get_tags_from_txt(image_path):
    """Read tags from sidecar .txt file."""
    base_path = image_path.rsplit('.', 1)[0]
    ext = image_path.rsplit('.', 1)[1] if '.' in image_path else ''
    possible_txt_paths = [f"{base_path}.txt", f"{base_path}.{ext}.txt"]

    tags = []
    txt_path_used = None

    for txt_path in possible_txt_paths:
        if os.path.exists(txt_path):
            with open(txt_path, 'r', encoding='utf-8') as f:
                tags = [line.strip().replace(' ', '_') for line in f.readlines() if line.strip()]
            txt_path_used = txt_path
            break

    logging.info(f"Tags found for {image_path}: {tags} from {txt_path_used if txt_path_used else 'no text file'}")
    return tags


def is_file_processed(file_name):
    """Check if file was already processed."""
    if LOG_FILE_PATH and LOG_FILE_PATH.exists():
        with open(LOG_FILE_PATH, 'r') as log_file:
            processed_files = log_file.readlines()
            return file_name + '\n' in processed_files
    return False


def log_processed_file(file_name):
    """Log processed file to avoid duplicates."""
    if LOG_FILE_PATH:
        with open(LOG_FILE_PATH, 'a') as log_file:
            log_file.write(file_name + '\n')


def upload_image(image_path):
    """Upload a single image with its tags."""
    logging.info(f"Attempting to process: {image_path}")

    # Retry loop to wait for file availability
    for _ in range(5):
        if os.path.exists(image_path):
            break
        logging.info(f"Waiting for file to appear: {image_path}")
        time.sleep(1)

    if not os.path.exists(image_path):
        logging.error(f"File still does not exist after waiting: {image_path}")
        return False

    filename = os.path.basename(image_path)
    logging.info(f"Filename extracted: {filename}")

    if is_file_processed(filename):
        logging.info(f"File {filename} already processed. Deleting...")
        os.remove(image_path)
        cleanup_txt_files(image_path)
        return True

    try:
        # Step 1: Upload file to get token
        with open(image_path, 'rb') as uploadfile:
            logging.info(f"Uploading file: {image_path}")
            files = {"content": (filename, uploadfile)}
            response = session.post(f"{API_URL}/api/uploads", files=files)

            if response.status_code == 200:
                logging.info(f"Successfully uploaded {image_path}")
                file_token = response.json().get("token")

                if file_token:
                    # Step 2: Create post with token and tags
                    tags = get_tags_from_txt(image_path)
                    post_data = {
                        "contentToken": file_token,
                        "safety": "safe",
                        "tags": tags
                    }
                    logging.info(f"Creating post with data: {post_data}")
                    post_response = session.post(
                        f"{API_URL}/api/posts",
                        json=post_data
                    )

                    if post_response.status_code == 200:
                        logging.info(f"Successfully created post for {image_path} with tags: {tags}")
                        cleanup_txt_files(image_path)
                        os.remove(image_path)
                        logging.info(f"Deleted image file: {image_path}")
                        log_processed_file(filename)
                        return True
                    elif post_response.status_code == 409:
                        logging.info(f"Duplicate post detected for {image_path}, cleaning up")
                        cleanup_txt_files(image_path)
                        os.remove(image_path)
                        log_processed_file(filename)
                        return True
                    else:
                        logging.error(f"Failed to create post: {post_response.status_code} - {post_response.text}")
                        return False
                else:
                    logging.error("Failed to get file token")
                    return False
            else:
                logging.error(f"Failed to upload: {response.status_code} - {response.text}")
                return False

    except Exception as e:
        logging.error(f"Error uploading {image_path}: {e}")
        return False


def cleanup_txt_files(image_path):
    """Remove associated .txt tag files."""
    base_path = image_path.rsplit('.', 1)[0]
    ext = image_path.rsplit('.', 1)[1] if '.' in image_path else ''

    for txt_path in [f"{base_path}.txt", f"{base_path}.{ext}.txt"]:
        if os.path.exists(txt_path):
            os.remove(txt_path)
            logging.info(f"Deleted {txt_path}")


def process_directory():
    """Process all images in the upload directory."""
    if not UPLOAD_DIR:
        print("ERROR: UPLOAD_DIR not set!")
        return

    logging.info(f"Scanning directory {UPLOAD_DIR}")
    supported_extensions = ('.jpg', '.png', '.gif', '.webm', '.jpeg', '.webp', '.mp4')

    for filename in os.listdir(UPLOAD_DIR):
        if filename.lower().endswith(supported_extensions):
            image_path = os.path.join(UPLOAD_DIR, filename)
            logging.info(f"Processing {image_path}")
            upload_image(image_path)


if __name__ == "__main__":
    if len(sys.argv) == 2:
        # Single file mode (for Grabber integration)
        image_path = sys.argv[1]
        logging.info(f"Received argument: {image_path}")
        success = upload_image(image_path)
        sys.exit(0 if success else 1)
    else:
        # Directory scan mode (manual run)
        process_directory()
        sys.exit(0)
