"""Small packaged-app system tray helpers."""
from __future__ import annotations

import os
import webbrowser
from collections.abc import Callable
from pathlib import Path


def start_windows_tray(
    *,
    app_name: str,
    url: str,
    icon_path: Path | None,
    shutdown: Callable[[], None],
):
    """Start a Windows tray icon for the packaged server.

    The tray is intentionally optional. If the dependency or desktop shell is
    unavailable, the server should still run normally.
    """
    if os.name != "nt":
        return None

    try:
        import pystray
        from PIL import Image, ImageDraw
    except Exception as exc:
        print(f"System tray unavailable: {exc}")
        return None

    def load_icon_image():
        if icon_path and icon_path.exists():
            return Image.open(icon_path)
        image = Image.new("RGBA", (64, 64), (19, 22, 28, 255))
        draw = ImageDraw.Draw(image)
        draw.polygon([(8, 48), (18, 16), (30, 48)], fill=(255, 139, 111, 255))
        draw.polygon([(34, 48), (46, 16), (58, 48)], fill=(255, 139, 111, 255))
        return image

    icon = None

    def open_app(_icon, _item):
        webbrowser.open(url)

    def turn_off(active_icon, _item):
        shutdown()
        try:
            active_icon.stop()
        except Exception:
            pass

    icon = pystray.Icon(
        "NekoBooru",
        load_icon_image(),
        title=app_name,
        menu=pystray.Menu(
            pystray.MenuItem("Open NekoBooru", open_app, default=True),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("Shut Down NekoBooru", turn_off),
        ),
    )

    try:
        icon.run_detached()
    except Exception as exc:
        print(f"Could not start system tray: {exc}")
        return None
    return icon
