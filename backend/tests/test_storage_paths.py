"""Stored file paths must resolve on any machine and OS the project is moved
to: Windows paths on Linux and the other way round, the old "agrotwin" folder
name, and raw DJI frames kept outside the project.

Run (from backend/):  python -m tests.test_storage_paths
"""

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import settings  # noqa: E402
from app.services import storage_service as st  # noqa: E402


def _touch(p: Path) -> Path:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(b"x")
    return p


def run_checks(tmp: Path):
    project = tmp / "argoTwinv2"
    raw = tmp / "flights"
    tif = _touch(project / "data" / "surveys" / "s1" / "outputs" / "ortho.tif")
    tiles = _touch(project / "frontend" / "public" / "tiles" / "s1" / "orthomosaic" / "tilemeta.json")
    jpg = _touch(raw / "DJI_202606031411_012_Field" / "DJI_0001_D.JPG")

    saved = st.AGROTWIN_ROOT, settings.raw_data_root
    st.AGROTWIN_ROOT, settings.raw_data_root = project, raw
    try:
        # written on Windows, read here
        assert st.resolve_path(r"D:\argoTwinv2\data\surveys\s1\outputs\ortho.tif") == tif
        # the old Linux mount and project folder name
        assert st.resolve_path("/media/cdev/Personal1/Development/Agro/agrotwin/frontend/public/tiles/s1/orthomosaic/tilemeta.json") == tiles
        # raw frames: under the old survey drive, in the project's Data folder, or anywhere else
        assert st.resolve_path("/media/cdev/Personal1/Development/Agro/DJI_202606031411_012_Field/DJI_0001_D.JPG") == jpg
        assert st.resolve_path(r"D:\argoTwinv2\Data\DJI_202606031411_012_Field\DJI_0001_D.JPG") == jpg
        assert st.resolve_path(r"E:\flights\DJI_202606031411_012_Field\DJI_0001_D.JPG") == jpg
        # nothing to re-root onto: left as stored
        assert st.resolve_path("/elsewhere/unknown.tif") == Path("/elsewhere/unknown.tif")
    finally:
        st.AGROTWIN_ROOT, settings.raw_data_root = saved


def main():
    with tempfile.TemporaryDirectory() as d:
        run_checks(Path(d))
    print("storage paths: all checks passed")


if __name__ == "__main__":
    main()
