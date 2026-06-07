#!/usr/bin/env python
"""Benchmark NekoBooru's default WD image tagger on CPU and/or GPU.

Times the real tagging pipeline (letterbox preprocess + ONNX inference) for the
default WD-EVA02-Large tagger -- the model that runs for normal auto-tagging --
and reports per-image latency, throughput, and projected bulk run times.

Run it with the SAME venv that has the AI stack installed (the one
install-ai.ps1 / install-ai.sh set up):

  Windows:   venv\\Scripts\\python.exe benchmark-tagger.py
  Linux/mac: venv/bin/python benchmark-tagger.py

Options:
  --device {cpu,gpu,both}   what to benchmark (default: both)
  --images PATH             a folder (or single file) of real images to use
  --count N                 synthetic images to generate when --images is unset
                            (default: 24)
  --runs N                  timed iterations (default: max(image count, 24))
  --warmup N                untimed warmup iterations (default: 2)

With no --images it generates random images so it runs with zero setup;
inference time for this model is independent of image content, so the numbers
are representative either way. Requires the WD model.onnx (downloaded once via
the app's Settings -> Auto Tagging, or fetched here on first run).
"""
import argparse
import statistics
import sys
import tempfile
import time
from pathlib import Path

WD_MODEL_ID = "SmilingWolf/wd-eva02-large-tagger-v3"
IMG_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif"}


def _need(mod):
    try:
        return __import__(mod)
    except ImportError:
        sys.exit(
            f"'{mod}' is not installed in this interpreter.\n"
            f"Run install-ai.ps1 / install-ai.sh first, and launch this with that venv's python."
        )


def letterbox(image, target=448):
    from PIL import Image
    width, height = image.size
    scale = min(target / width, target / height)
    new_size = (max(1, int(width * scale)), max(1, int(height * scale)))
    resized = image.resize(new_size, Image.BICUBIC)
    canvas = Image.new("RGB", (target, target), (255, 255, 255))
    canvas.paste(resized, ((target - new_size[0]) // 2, (target - new_size[1]) // 2))
    return canvas


def preprocess(path):
    """Match WdTagger.tag_image: letterbox to 448, raw float32 0-255, NHWC."""
    import numpy as np
    from PIL import Image
    with Image.open(path) as im:
        im = im.convert("RGB")
        im = letterbox(im, 448)
        return np.asarray(im, dtype=np.float32)[None, ...]


def gather_images(args):
    if args.images:
        d = Path(args.images)
        if d.is_dir():
            files = [p for p in sorted(d.iterdir()) if p.suffix.lower() in IMG_EXTS]
        elif d.is_file():
            files = [d]
        else:
            sys.exit(f"--images path not found: {args.images}")
        if not files:
            sys.exit(f"No images found in {args.images}")
        return files, None

    import numpy as np
    from PIL import Image
    tmp = tempfile.mkdtemp(prefix="neko-bench-")
    rng = np.random.default_rng(0)
    files = []
    for i in range(max(1, args.count)):
        arr = rng.integers(0, 256, size=(768, 768, 3), dtype="uint8")
        p = Path(tmp) / f"synthetic_{i:03d}.png"
        Image.fromarray(arr).save(p)
        files.append(p)
    return files, tmp


def resolve_model():
    hub = _need("huggingface_hub")
    try:
        return hub.hf_hub_download(WD_MODEL_ID, "model.onnx")
    except Exception as exc:  # noqa: BLE001
        sys.exit(
            f"Could not obtain the WD model.onnx ({exc}).\n"
            f"Download the WD model once via the app (Settings -> Auto Tagging), "
            f"or ensure network access, then retry."
        )


def make_session(device, model_path):
    ort = _need("onnxruntime")
    if device == "cpu":
        providers = ["CPUExecutionProvider"]
    else:
        providers = ["CUDAExecutionProvider", "CPUExecutionProvider"]
    t0 = time.perf_counter()
    sess = ort.InferenceSession(model_path, providers=providers)
    load_s = time.perf_counter() - t0
    return sess, sess.get_providers(), load_s


def fmt_dur(seconds):
    seconds = int(round(seconds))
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    if h:
        return f"{h}h {m}m {s}s"
    if m:
        return f"{m}m {s}s"
    return f"{s}s"


def bench_device(device, model_path, files, runs, warmup):
    sess, providers, load_s = make_session(device, model_path)
    if device == "gpu" and "CUDAExecutionProvider" not in providers:
        return {"device": device, "skipped":
                "CUDA execution provider unavailable (no onnxruntime-gpu, or GPU not visible)."}

    input_name = sess.get_inputs()[0].name
    n = len(files)
    for i in range(warmup):
        sess.run(None, {input_name: preprocess(files[i % n])})

    times = []
    for i in range(runs):
        p = files[i % n]
        t0 = time.perf_counter()
        arr = preprocess(p)
        sess.run(None, {input_name: arr})
        times.append(time.perf_counter() - t0)

    mean = statistics.mean(times)
    return {
        "device": device,
        "providers": providers,
        "load_s": load_s,
        "runs": runs,
        "mean_ms": mean * 1000.0,
        "median_ms": statistics.median(times) * 1000.0,
        "min_ms": min(times) * 1000.0,
        "max_ms": max(times) * 1000.0,
        "ips": (1.0 / mean) if mean > 0 else 0.0,
    }


def print_result(r):
    label = "GPU" if r["device"] == "gpu" else "CPU"
    if r.get("skipped"):
        print(f"  [{label}] skipped: {r['skipped']}")
        return
    print(f"  [{label}] providers: {', '.join(r['providers'])}")
    print(f"  [{label}] model load: {r['load_s']:.2f} s")
    print(f"  [{label}] per image (n={r['runs']}): "
          f"mean {r['mean_ms']:.0f} ms | median {r['median_ms']:.0f} ms | "
          f"min {r['min_ms']:.0f} ms | max {r['max_ms']:.0f} ms")
    print(f"  [{label}] throughput: {r['ips']:.2f} images/sec")
    per = 1.0 / r["ips"] if r["ips"] else 0.0
    proj = "  ".join(f"{count:,}: {fmt_dur(per * count)}" for count in (1000, 10000, 100000))
    print(f"  [{label}] projected bulk: {proj}")


def main():
    ap = argparse.ArgumentParser(description="Benchmark the WD auto-tagger on CPU/GPU.")
    ap.add_argument("--device", choices=["cpu", "gpu", "both"], default="both")
    ap.add_argument("--images", help="folder or file of real images to tag")
    ap.add_argument("--count", type=int, default=24, help="synthetic images if --images unset")
    ap.add_argument("--runs", type=int, default=0, help="timed iterations (default max(images,24))")
    ap.add_argument("--warmup", type=int, default=2)
    args = ap.parse_args()

    _need("numpy")
    _need("PIL")
    files, tmp = gather_images(args)
    runs = args.runs if args.runs > 0 else max(len(files), 24)
    model_path = resolve_model()

    print("=" * 60)
    print("NekoBooru WD tagger benchmark")
    print(f"  model:   {WD_MODEL_ID}")
    print(f"  images:  {len(files)} "
          f"({'synthetic' if tmp else 'from ' + str(args.images)}), {runs} timed runs")
    print("=" * 60)

    devices = ["cpu", "gpu"] if args.device == "both" else [args.device]
    results = {}
    for d in devices:
        print(f"\nBenchmarking {d.upper()} ...")
        try:
            results[d] = bench_device(d, model_path, files, runs, args.warmup)
        except Exception as exc:  # noqa: BLE001
            results[d] = {"device": d, "skipped": str(exc)}
        print_result(results[d])

    cpu, gpu = results.get("cpu"), results.get("gpu")
    if cpu and gpu and not cpu.get("skipped") and not gpu.get("skipped") and cpu["ips"]:
        print(f"\nGPU is ~{gpu['ips'] / cpu['ips']:.1f}x faster than CPU for WD tagging.")

    if tmp:
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
