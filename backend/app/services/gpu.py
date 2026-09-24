"""Shared helpers for the GPU-first processing paths.

Every heavy stage follows the same shape: decode/read on a pool of CPU
threads (JPEG decoding and WebP encoding are CPU-only on a GeForce card —
nvJPEG measured no faster than libjpeg here — but they scale ~6-11x across
threads because Pillow releases the GIL), and do the per-pixel math on the
GPU with torch, falling back to numpy when CUDA is unavailable.
"""

from __future__ import annotations

import logging
import os
from collections import deque
from collections.abc import Callable, Iterable, Iterator
from concurrent.futures import ThreadPoolExecutor
from typing import TypeVar

log = logging.getLogger(__name__)

T = TypeVar("T")
R = TypeVar("R")

# Leave room for the Ollama model (~9.5 GB when loaded) and the desktop.
GPU_HEADROOM_BYTES = 1_500_000_000


def cuda_torch():
    """torch with a usable CUDA device, or None."""
    try:
        import torch
    except ImportError:
        return None
    return torch if torch.cuda.is_available() else None


def gpu_can_hold(nbytes: int) -> bool:
    torch = cuda_torch()
    if torch is None:
        return False
    free, _ = torch.cuda.mem_get_info()
    return free >= nbytes + GPU_HEADROOM_BYTES


def release_gpu_memory() -> None:
    """Returns cached blocks to the driver so Ollama / training can use them."""
    torch = cuda_torch()
    if torch is not None:
        torch.cuda.empty_cache()


def default_workers() -> int:
    # keep a couple of cores for the API and the GPU feeder thread
    return max(2, min(16, (os.cpu_count() or 4) - 2))


def prefetch(items: Iterable[T], fn: Callable[[T], R], workers: int | None = None,
             ahead: int | None = None) -> Iterator[tuple[T, R]]:
    """Yields (item, fn(item)) in input order while fn runs on a thread pool,
    with at most `ahead` results in flight so a 1,000-frame survey is never
    held in memory at once. Exceptions raised by fn propagate at that item."""
    workers = workers or default_workers()
    ahead = ahead or workers * 2
    it = iter(items)
    with ThreadPoolExecutor(workers, thread_name_prefix="agrotwin-io") as ex:
        pending: deque = deque()

        def submit_next() -> None:
            for item in it:
                pending.append((item, ex.submit(fn, item)))
                return

        for _ in range(ahead):
            submit_next()
        while pending:
            item, fut = pending.popleft()
            submit_next()
            yield item, fut.result()
