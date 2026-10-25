import asyncio
import importlib
import logging
import sys
from pathlib import Path

import httpx
import pytest


@pytest.fixture(scope="module")
def legacy_server():
    package_root = Path(__file__).parents[2] / "cwm-mcp"
    module_names = ("api_gateway.server", "api_gateway")
    saved_modules = {name: sys.modules.get(name) for name in module_names}
    httpx_logger = logging.getLogger("httpx")
    saved_httpx_logger_level = httpx_logger.level
    for name in module_names:
        sys.modules.pop(name, None)
    sys.path.insert(0, str(package_root))
    try:
        yield importlib.import_module("api_gateway.server")
    finally:
        httpx_logger.setLevel(saved_httpx_logger_level)
        sys.path.remove(str(package_root))
        for name in module_names:
            sys.modules.pop(name, None)
            saved_module = saved_modules[name]
            if saved_module is not None:
                sys.modules[name] = saved_module


def test_logging_uses_only_the_bounded_container_stream(legacy_server):
    source = Path(legacy_server.__file__).read_text(encoding="utf-8")

    assert "logging.FileHandler" not in source
    assert "api_gateway.log" not in source
    assert not hasattr(legacy_server, "log_file")
    assert (
        legacy_server.FAST_MEMORY_DB_PATH
        == "/run/connectwise-memory/fast_memory_api.db"
    )


def test_fast_memory_logs_do_not_expose_saved_query_content(
    legacy_server, tmp_path, caplog
):
    canaries = {
        "description": "description-canary",
        "path": "/service/tickets/path-canary",
        "method": "method-canary",
        "params": "params-canary",
        "data": "data-canary",
    }

    with caplog.at_level(logging.INFO):
        database = legacy_server.FastMemoryDB(str(tmp_path / "memory.db"))
        try:
            database.save_query(
                canaries["description"],
                canaries["path"],
                canaries["method"],
                params={"conditions": canaries["params"]},
                data={"notes": canaries["data"]},
            )
            database.save_query(
                canaries["description"],
                canaries["path"],
                canaries["method"],
            )
        finally:
            database.close()

    assert all(value not in caplog.text for value in canaries.values())
    assert "Saved new Fast Memory query" in caplog.text
    assert "Updated existing Fast Memory query" in caplog.text


def test_api_request_does_not_expose_request_or_response_content(
    legacy_server, monkeypatch, caplog
):
    canaries = {
        "endpoint": "endpoint-canary",
        "parameter": "parameter-canary",
        "payload": "payload-canary",
        "response": "response-canary",
    }
    monkeypatch.setattr(
        legacy_server,
        "API_URL",
        "https://connectwise.example.invalid/",
    )

    def handler(request):
        return httpx.Response(
            403,
            text=canaries["response"],
            request=request,
        )

    real_async_client = httpx.AsyncClient

    def mock_async_client(**kwargs):
        return real_async_client(
            transport=httpx.MockTransport(handler),
            **kwargs,
        )

    monkeypatch.setattr(legacy_server.httpx, "AsyncClient", mock_async_client)

    with caplog.at_level(logging.INFO):
        with pytest.raises(legacy_server.APIError) as exc_info:
            asyncio.run(
                legacy_server.make_api_request(
                    "post",
                    f"service/tickets/{canaries['endpoint']}",
                    params={"conditions": canaries["parameter"]},
                    data={"notes": canaries["payload"]},
                    headers={"Authorization": "test-only"},
                )
            )

    error = exc_info.value
    combined_output = caplog.text + str(error)
    assert all(value not in combined_output for value in canaries.values())
    assert str(error) == "ConnectWise API returned HTTP 403."
    assert error.status_code == 403
    assert error.response is None
    assert error.__cause__ is None
    assert error.__context__ is None
    assert "Making ConnectWise API request (method=POST)" in caplog.text
    assert "ConnectWise API request failed (status=403)" in caplog.text
    assert "HTTP Request:" not in caplog.text


def test_unsupported_method_is_not_logged_or_surfaced(
    legacy_server, monkeypatch, caplog
):
    method_canary = "method-canary"
    monkeypatch.setattr(
        legacy_server,
        "API_URL",
        "https://connectwise.example.invalid/",
    )

    with caplog.at_level(logging.INFO):
        with pytest.raises(legacy_server.APIError) as exc_info:
            asyncio.run(
                legacy_server.make_api_request(
                    method_canary,
                    "service/tickets",
                    headers={"Authorization": "test-only"},
                )
            )

    combined_output = caplog.text + str(exc_info.value)
    assert method_canary not in combined_output
    assert str(exc_info.value) == "Unsupported HTTP method."
    assert "Unsupported ConnectWise API request method." in caplog.text
