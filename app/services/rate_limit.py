from __future__ import annotations

import threading
import time
from collections import deque


class SlidingWindowRateLimiter:
    """In-process sliding-window limiter.

    Valid because the backend runs as a single worker in a single instance. Keys
    are opaque strings; the caller builds them (e.g. ``invite:{company}:{actor}``).
    """

    def __init__(self, max_events: int, window_seconds: float = 60.0) -> None:
        self._max = max(1, max_events)
        self._window = window_seconds
        self._events: dict[str, deque[float]] = {}
        self._lock = threading.Lock()

    def allow(self, key: str, *, now: float | None = None) -> bool:
        moment = time.monotonic() if now is None else now
        with self._lock:
            bucket = self._events.setdefault(key, deque())
            cutoff = moment - self._window
            while bucket and bucket[0] <= cutoff:
                bucket.popleft()
            if len(bucket) >= self._max:
                return False
            bucket.append(moment)
            return True

    def reset(self, key: str | None = None) -> None:
        with self._lock:
            if key is None:
                self._events.clear()
            else:
                self._events.pop(key, None)
