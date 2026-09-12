#!/usr/bin/env python3
"""Drive one PTY echo through a packaged app's preload bridge."""

import json
import os
import sys
import time
import urllib.request
from collections import Counter
from typing import Dict, List, Optional, Tuple

import websocket


DEFAULT_DEBUG_TARGETS_URL = "http://127.0.0.1:9222/json/list"
DEFAULT_DISCOVERY_DEADLINE_MS = 20_000
DEFAULT_ECHO_DEADLINE_MS = 30_000
ECHO_REPORT_MARGIN_MS = 10_000
MARKER = "OK_PACKAGED_PTY_ECHO"
MAX_OBSERVED_TARGETS = 8
MAX_TARGET_FIELD_LENGTH = 160


def summarize_target(target: Dict[str, object], outcome: str) -> Tuple[str, str, str, str]:
    def bounded(field: str) -> str:
        return str(target.get(field, ""))[:MAX_TARGET_FIELD_LENGTH]

    return (bounded("type"), bounded("url"), bounded("title"), outcome)


def record_observed_target(
    observed_targets: List[Tuple[str, str, str, str]],
    target: Dict[str, object],
    outcome: str,
) -> None:
    summary = summarize_target(target, outcome)
    if summary in observed_targets:
        observed_targets.remove(summary)
    observed_targets.append(summary)
    del observed_targets[:-MAX_OBSERVED_TARGETS]


class ConnectPhaseTimeoutError(TimeoutError):
    pass


class ReplyPhaseTimeoutError(TimeoutError):
    pass


def evaluate_value(socket_url: str, expression: str, timeout: float = 5) -> object:
    deadline = time.monotonic() + timeout
    connection = websocket.create_connection(
        socket_url, timeout=timeout, origin="http://localhost"
    )
    request = {
        "id": 1,
        "method": "Runtime.evaluate",
        "params": {
            "expression": expression,
            "awaitPromise": True,
            "returnByValue": True,
        },
    }
    try:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise ConnectPhaseTimeoutError(
                f"connect and handshake spent the whole {timeout:.1f}s budget "
                "before the CDP request could be sent"
            )
        connection.settimeout(remaining)
        connection.send(json.dumps(request))
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ReplyPhaseTimeoutError(
                    f"no CDP reply for id=1 within {timeout:.1f}s"
                )
            connection.settimeout(remaining)
            message = json.loads(connection.recv())
            if message.get("id") != 1:
                continue
            if "error" in message:
                raise RuntimeError(f"CDP evaluation failed: {message['error']}")
            result = message.get("result", {})
            if result.get("exceptionDetails"):
                detail = result["exceptionDetails"]
                exception = detail.get("exception", {}).get("description")
                raise RuntimeError(
                    exception or detail.get("text", "renderer evaluation threw")
                )
            return result.get("result", {}).get("value")
    finally:
        connection.close()


def discovery_deadline_ms() -> int:
    return int(os.environ.get("OK_SMOKE_DISCOVERY_DEADLINE_MS") or DEFAULT_DISCOVERY_DEADLINE_MS)


def echo_deadline_ms() -> int:
    return int(os.environ.get("OK_SMOKE_ECHO_DEADLINE_MS") or DEFAULT_ECHO_DEADLINE_MS)


def renderer_echo_timeout_ms() -> int:
    budget = echo_deadline_ms()
    remaining = budget - ECHO_REPORT_MARGIN_MS
    if remaining <= 0:
        raise ValueError(
            f"OK_SMOKE_ECHO_DEADLINE_MS={budget} leaves no room for the renderer's own timer, "
            f"which must fire {ECHO_REPORT_MARGIN_MS}ms earlier so its partial-output message wins "
            f"the race against the socket bound; set it above {ECHO_REPORT_MARGIN_MS}"
        )
    return remaining


def debug_targets_url() -> str:
    return os.environ.get("OK_SMOKE_CDP_LIST_URL") or DEFAULT_DEBUG_TARGETS_URL


def describe_discovery_phase(
    budget_ms: int,
    elapsed: float,
    listed_at: Optional[float],
    paged_at: Optional[float],
    probes: int,
    targets_seen: int,
    list_failures: Counter,
    probe_failures: Counter,
) -> str:
    if listed_at is None:
        reached = "the debug endpoint never answered"
    elif paged_at is None:
        reached = f"the debug endpoint answered at {listed_at:.1f}s but listed no page target"
    elif probes == 0:
        reached = (
            f"the debug endpoint answered at {listed_at:.1f}s and a page target appeared at "
            f"{paged_at:.1f}s, but the budget ran out before it could be probed"
        )
    else:
        reached = (
            f"the debug endpoint answered at {listed_at:.1f}s, a page target appeared at "
            f"{paged_at:.1f}s, and {probes} probe(s) across {targets_seen} page target(s) "
            f"never reported an editor"
        )
    return (
        f"{reached}; gave up after {elapsed:.1f}s of a {budget_ms / 1000:.0f}s budget; "
        f"list_failures={dict(list_failures)}; probe_failures={dict(probe_failures)}"
    )


def find_editor_websocket() -> str:
    budget_ms = discovery_deadline_ms()
    started = time.monotonic()
    deadline = started + budget_ms / 1000
    observed_targets: List[Tuple[str, str, str, str]] = []
    listed_at: Optional[float] = None
    paged_at: Optional[float] = None
    probes = 0
    probed_targets: set = set()
    list_failures: Counter = Counter()
    probe_failures: Counter = Counter()
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(debug_targets_url(), timeout=2) as response:
                targets = json.load(response)
            if listed_at is None:
                listed_at = time.monotonic() - started
            for target in targets:
                socket_url = target.get("webSocketDebuggerUrl")
                if target.get("type") != "page" or not socket_url:
                    continue
                if paged_at is None:
                    paged_at = time.monotonic() - started
                if time.monotonic() >= deadline:
                    break
                probes += 1
                probed_targets.add(summarize_target(target, "")[:3])
                try:
                    is_project_editor = evaluate_value(
                        str(socket_url),
                        "window.okDesktop?.config?.mode === 'editor'"
                        " && window.okDesktop.config.projectPath.length > 0",
                        timeout=2,
                    )
                    record_observed_target(
                        observed_targets,
                        target,
                        "editor" if is_project_editor is True else "not-editor",
                    )
                    if is_project_editor is True:
                        return str(socket_url)
                except RuntimeError as error:
                    record_observed_target(observed_targets, target, "answered-with-error")
                    probe_failures[type(error).__name__] += 1
                except (ConnectPhaseTimeoutError, ReplyPhaseTimeoutError) as error:
                    record_observed_target(observed_targets, target, "answered-but-silent")
                    probe_failures[type(error).__name__] += 1
                except Exception as error:
                    record_observed_target(observed_targets, target, "unreachable")
                    probe_failures[type(error).__name__] += 1
        except Exception as error:
            list_failures[type(error).__name__] += 1
        time.sleep(0.25)
    raise RuntimeError(
        "no project editor debug target appeared; "
        + describe_discovery_phase(
            budget_ms,
            time.monotonic() - started,
            listed_at,
            paged_at,
            probes,
            len(probed_targets),
            list_failures,
            probe_failures,
        )
        + f"; observed_targets={observed_targets!r}"
    )


def evaluate_pty_echo(socket_url: str) -> Dict[str, object]:
    expression = f"""
      (async () => {{
        const bridge = window.okDesktop;
        if (!bridge?.config?.ptyAvailable) {{
          throw new Error('packaged renderer did not expose PTY capability');
        }}
        if (typeof bridge.platform !== 'string') {{
          throw new Error('packaged renderer did not expose its platform');
        }}
        const marker = {json.dumps(MARKER)};
        const startedAt = performance.now();
        return await new Promise(async (resolve, reject) => {{
          let output = '';
          let ptyId = null;
          let settled = false;
          let unsubscribe = () => {{}};
          let createdAt = null;
          let firstByteAt = null;
          let markerAt = null;
          const sinceStart = (at) => (at === null ? null : Math.round(at - startedAt));
          const timings = () => ({{
            createdMs: sinceStart(createdAt),
            firstByteMs: sinceStart(firstByteAt),
            markerMs: sinceStart(markerAt),
          }});
          const finish = async (error) => {{
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            unsubscribe();
            if (ptyId !== null) await bridge.terminal.kill(ptyId).catch(() => {{}});
            if (error) reject(error);
            else resolve({{ output, platform: bridge.platform, timings: timings() }});
          }};
          const consume = (data, at) => {{
            if (firstByteAt === null) firstByteAt = at;
            output += data;
            const plainOutput = output
              .replace(
                /\\u001b\\](?:[^\\u0007\\u001b]|\\u001b(?!\\\\))*(?:\\u0007|\\u001b\\\\)/g,
                '',
              )
              .replace(/\\u001b\\[[0-?]*[ -/]*[@-~]/g, '');
            // Windows bakes the marker command into shell startup. POSIX types
            // it only after creation, where the echoed input includes `echo `.
            // Requiring a marker-only output line rejects that input echo on
            // both paths and rejects partial writes.
            const markerReachedOutput =
              plainOutput
                .match(/[^\\r\\n]*(?:\\r\\n|\\r|\\n)/g)
                ?.some((line) => line.trim() === marker) ?? false;
            if (markerReachedOutput) {{
              markerAt = at;
              void finish(null);
            }}
          }};
          const timeout = setTimeout(
            () =>
              void finish(
                new Error(
                  `PTY echo timed out; output=${{JSON.stringify(output)}}; timings=${{JSON.stringify(timings())}}`,
                ),
              ),
            {renderer_echo_timeout_ms()},
          );
          unsubscribe = bridge.terminal.onData((message) => {{
            if (message.ptyId !== ptyId) return;
            consume(message.data, performance.now());
          }});
          const isWindows = bridge.platform === 'win32';
          const created = await bridge.terminal.create({{
            cols: 80,
            rows: 24,
            ...(isWindows
              ? {{
                  launchCommand: {{
                    executable: 'cmd.exe',
                    args: ['/d', '/c', 'echo', marker],
                  }},
                }}
              : {{}}),
          }});
          if (!created.ok) {{
            await finish(new Error(`PTY create failed: ${{created.reason}}`));
            return;
          }}
          createdAt = performance.now();
          ptyId = created.ptyId;
          const attached = await bridge.terminal.start(ptyId);
          if (!attached.ok) {{
            await finish(new Error(`PTY attach failed: ${{attached.reason}}`));
            return;
          }}
          if (!isWindows) bridge.terminal.input(ptyId, `echo ${{marker}}\\r`);
        }});
      }})()
    """
    budget_ms = echo_deadline_ms()
    started = time.monotonic()
    try:
        value = evaluate_value(socket_url, expression, timeout=budget_ms / 1000)
    except Exception as error:
        raise RuntimeError(
            f"the editor target did not report a PTY echo; "
            f"gave up after {time.monotonic() - started:.1f}s of a {budget_ms / 1000:.0f}s budget; "
            f"renderer_timer={renderer_echo_timeout_ms() / 1000:.0f}s; "
            f"error={type(error).__name__}: {error}"
        ) from error
    if not isinstance(value, dict):
        raise RuntimeError(f"renderer returned no PTY smoke result: {value}")
    return value


def main() -> int:
    try:
        discovery_deadline_ms()
        renderer_echo_timeout_ms()
    except ValueError as error:
        print(f"ERROR: packaged PTY smoke misconfigured: {error}", file=sys.stderr)
        return 1
    try:
        result = evaluate_pty_echo(find_editor_websocket())
    except Exception as error:
        print(f"ERROR: packaged PTY echo failed: {error}", file=sys.stderr)
        return 1
    # A driver tunneled to a packaged app on another OS pins the target via the
    # environment; a local driver defaults to its own platform.
    expected_platform = os.environ.get("OK_SMOKE_EXPECT_PLATFORM") or sys.platform
    if result.get("platform") != expected_platform:
        print(
            "ERROR: packaged PTY driver exercised "
            f"{result.get('platform')!r}, expected {expected_platform!r}; result={result!r}",
            file=sys.stderr,
        )
        return 1
    print(f"PTY echo marker observed: {MARKER}; timings={json.dumps(result.get('timings'))}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
