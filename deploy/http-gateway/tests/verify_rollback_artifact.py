"""Fail-closed verification for a retained legacy rollback image bundle."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
from contextlib import contextmanager
from pathlib import Path
from typing import Any, BinaryIO, Iterator

ARCHIVE_NAME = "connectwise-legacy-rollback-image.tar.gz"
CHECKSUM_NAME = "connectwise-legacy-rollback-image.sha256"
MANIFEST_NAME = "connectwise-legacy-rollback-image.json"
SBOM_NAME = "connectwise-legacy-rollback-image.cdx.json"
COMPOSE_NAME = "connectwise-legacy-rollback-compose.yml"
MAX_SBOM_BYTES = 16 * 1024 * 1024
MAX_COMPOSE_BYTES = 256 * 1024
IMAGE_REPOSITORY = "connectwise-legacy-rollback-ci"
MANIFEST_KEYS = {
    "schemaVersion",
    "releaseCommit",
    "workflowRunId",
    "imageRepository",
    "imageId",
    "archive",
    "archiveSha256",
    "sbom",
    "sbomSha256",
    "compose",
    "composeSha256",
}
COMMIT_RE = re.compile(r"[0-9a-f]{40}")
SHA256_RE = re.compile(r"[0-9a-f]{64}")
IMAGE_ID_RE = re.compile(r"sha256:[0-9a-f]{64}")
RUN_ID_RE = re.compile(r"[1-9][0-9]*")


def _identity(metadata: os.stat_result) -> tuple[int, int, int, int, int, int, int]:
    return (
        metadata.st_dev,
        metadata.st_ino,
        metadata.st_mode,
        metadata.st_nlink,
        metadata.st_size,
        metadata.st_mtime_ns,
        metadata.st_ctime_ns,
    )


def _validate_regular_file(metadata: os.stat_result, name: str) -> None:
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
        raise ValueError(
            f"Artifact file must be a regular non-symlink single-link: {name}"
        )


@contextmanager
def _artifact_directory(directory: Path) -> Iterator[int]:
    try:
        path_metadata = directory.lstat()
    except OSError as exc:
        raise ValueError("Artifact directory does not exist or is not a directory") from exc
    if stat.S_ISLNK(path_metadata.st_mode) or not stat.S_ISDIR(path_metadata.st_mode):
        raise ValueError("Artifact directory must be a non-symlink directory")

    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    try:
        descriptor = os.open(directory, flags)
    except OSError as exc:
        raise ValueError("Artifact directory must be a non-symlink directory") from exc
    try:
        descriptor_metadata = os.fstat(descriptor)
        if (
            not stat.S_ISDIR(descriptor_metadata.st_mode)
            or descriptor_metadata.st_dev != path_metadata.st_dev
            or descriptor_metadata.st_ino != path_metadata.st_ino
        ):
            raise ValueError("Artifact directory changed during verification")
        yield descriptor
    finally:
        os.close(descriptor)


@contextmanager
def _regular_file(directory_descriptor: int, name: str) -> Iterator[BinaryIO]:
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
    try:
        descriptor = os.open(name, flags, dir_fd=directory_descriptor)
    except FileNotFoundError as exc:
        raise ValueError(f"Missing required artifact file: {name}") from exc
    except OSError as exc:
        raise ValueError(
            f"Artifact file must be a regular non-symlink single-link: {name}"
        ) from exc

    with os.fdopen(descriptor, "rb") as artifact_file:
        before = os.fstat(artifact_file.fileno())
        _validate_regular_file(before, name)
        yield artifact_file
        after = os.fstat(artifact_file.fileno())
        _validate_regular_file(after, name)
        if _identity(after) != _identity(before):
            raise ValueError(f"Artifact file changed during verification: {name}")


def _require_exact_string(value: Any, expected: str, field: str) -> None:
    if type(value) is not str or value != expected:
        raise ValueError(f"Manifest {field} does not match the expected value")


def _write_private_verified_copy(output: Path, content: bytes) -> None:
    parent = output.parent
    try:
        parent_metadata = parent.lstat()
    except OSError as exc:
        raise ValueError("Verified Compose output parent does not exist") from exc
    if (
        stat.S_ISLNK(parent_metadata.st_mode)
        or not stat.S_ISDIR(parent_metadata.st_mode)
        or parent_metadata.st_uid != os.geteuid()
        or stat.S_IMODE(parent_metadata.st_mode) & 0o077
    ):
        raise ValueError(
            "Verified Compose output parent must be a private owned non-symlink directory"
        )

    parent_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    try:
        parent_descriptor = os.open(parent, parent_flags)
    except OSError as exc:
        raise ValueError(
            "Verified Compose output parent must be a non-symlink directory"
        ) from exc
    try:
        opened_parent = os.fstat(parent_descriptor)
        if (
            opened_parent.st_dev != parent_metadata.st_dev
            or opened_parent.st_ino != parent_metadata.st_ino
        ):
            raise ValueError("Verified Compose output parent changed")
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
        try:
            descriptor = os.open(output.name, flags, 0o400, dir_fd=parent_descriptor)
        except OSError as exc:
            raise ValueError("Verified Compose output must not already exist") from exc
        try:
            remaining = memoryview(content)
            while remaining:
                written = os.write(descriptor, remaining)
                if written <= 0:
                    raise ValueError("Could not write verified Compose output")
                remaining = remaining[written:]
            os.fsync(descriptor)
            os.fchmod(descriptor, 0o400)
        finally:
            os.close(descriptor)
    finally:
        os.close(parent_descriptor)


def verify_rollback_artifact(
    directory: Path,
    expected_release_commit: str,
    expected_workflow_run_id: str,
    verified_compose_output: Path | None = None,
) -> dict[str, Any]:
    if not COMMIT_RE.fullmatch(expected_release_commit):
        raise ValueError("Expected release commit must be 40 lowercase hexadecimal characters")
    if not RUN_ID_RE.fullmatch(expected_workflow_run_id):
        raise ValueError("Expected workflow run ID must be a positive decimal integer")

    with _artifact_directory(directory) as directory_descriptor:
        try:
            with _regular_file(directory_descriptor, MANIFEST_NAME) as manifest_file:
                manifest = json.loads(manifest_file.read().decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError("Manifest must be valid UTF-8 JSON") from exc
        if not isinstance(manifest, dict) or set(manifest) != MANIFEST_KEYS:
            raise ValueError("Manifest must contain exactly the required fields")
        if (
            type(manifest["schemaVersion"]) is not int
            or manifest["schemaVersion"] != 3
        ):
            raise ValueError("Manifest schemaVersion must be 3")

        _require_exact_string(
            manifest["releaseCommit"], expected_release_commit, "releaseCommit"
        )
        _require_exact_string(
            manifest["workflowRunId"], expected_workflow_run_id, "workflowRunId"
        )
        _require_exact_string(
            manifest["imageRepository"], IMAGE_REPOSITORY, "imageRepository"
        )
        _require_exact_string(manifest["archive"], ARCHIVE_NAME, "archive")
        _require_exact_string(manifest["sbom"], SBOM_NAME, "sbom")
        _require_exact_string(manifest["compose"], COMPOSE_NAME, "compose")

        image_id = manifest["imageId"]
        if type(image_id) is not str or not IMAGE_ID_RE.fullmatch(image_id):
            raise ValueError("Manifest imageId must be a lowercase sha256 Docker image ID")
        archive_sha256 = manifest["archiveSha256"]
        if type(archive_sha256) is not str or not SHA256_RE.fullmatch(archive_sha256):
            raise ValueError("Manifest archiveSha256 must be a lowercase SHA-256 digest")
        sbom_sha256 = manifest["sbomSha256"]
        if type(sbom_sha256) is not str or not SHA256_RE.fullmatch(sbom_sha256):
            raise ValueError("Manifest sbomSha256 must be a lowercase SHA-256 digest")
        compose_sha256 = manifest["composeSha256"]
        if type(compose_sha256) is not str or not SHA256_RE.fullmatch(
            compose_sha256
        ):
            raise ValueError("Manifest composeSha256 must be a lowercase SHA-256 digest")

        try:
            with _regular_file(directory_descriptor, CHECKSUM_NAME) as checksum_file:
                checksum_text = checksum_file.read().decode("ascii")
        except UnicodeDecodeError as exc:
            raise ValueError("Checksum file must be ASCII") from exc
        expected_checksum = f"{archive_sha256}  {ARCHIVE_NAME}\n"
        if checksum_text != expected_checksum:
            raise ValueError(
                "Checksum file does not exactly match the manifest and archive name"
            )

        digest = hashlib.sha256()
        with _regular_file(directory_descriptor, ARCHIVE_NAME) as archive_file:
            for chunk in iter(lambda: archive_file.read(1024 * 1024), b""):
                digest.update(chunk)
        if digest.hexdigest() != archive_sha256:
            raise ValueError("Rollback image archive SHA-256 mismatch")

        try:
            with _regular_file(directory_descriptor, SBOM_NAME) as sbom_file:
                sbom_bytes = sbom_file.read(MAX_SBOM_BYTES + 1)
            if len(sbom_bytes) > MAX_SBOM_BYTES:
                raise ValueError("SBOM exceeds the maximum allowed size")
            sbom = json.loads(sbom_bytes.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError("SBOM must be valid UTF-8 JSON") from exc
        if hashlib.sha256(sbom_bytes).hexdigest() != sbom_sha256:
            raise ValueError("Rollback image SBOM SHA-256 mismatch")
        components = sbom.get("components") if isinstance(sbom, dict) else None
        if (
            not isinstance(sbom, dict)
            or sbom.get("bomFormat") != "CycloneDX"
            or sbom.get("specVersion") not in {"1.4", "1.5", "1.6"}
            or type(sbom.get("version")) is not int
            or sbom["version"] < 1
            or not isinstance(components, list)
            or not components
            or any(
                not isinstance(component, dict)
                or type(component.get("type")) is not str
                or not component["type"].strip()
                or type(component.get("name")) is not str
                or not component["name"].strip()
                for component in components
            )
        ):
            raise ValueError("SBOM must be a valid CycloneDX component inventory")

        with _regular_file(directory_descriptor, COMPOSE_NAME) as compose_file:
            compose_bytes = compose_file.read(MAX_COMPOSE_BYTES + 1)
        if len(compose_bytes) > MAX_COMPOSE_BYTES:
            raise ValueError("Compose file exceeds the maximum allowed size")
        if not compose_bytes:
            raise ValueError("Compose file must not be empty")
        if hashlib.sha256(compose_bytes).hexdigest() != compose_sha256:
            raise ValueError("Rollback Compose file SHA-256 mismatch")
        if verified_compose_output is not None:
            _write_private_verified_copy(verified_compose_output, compose_bytes)
        return manifest


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Verify a retained legacy rollback image artifact bundle"
    )
    parser.add_argument("artifact_directory", type=Path)
    parser.add_argument("expected_release_commit")
    parser.add_argument("expected_workflow_run_id")
    parser.add_argument(
        "--verified-compose-output",
        type=Path,
        help="write the verified Compose bytes once to a new private file",
    )
    args = parser.parse_args()
    try:
        verify_rollback_artifact(
            args.artifact_directory,
            args.expected_release_commit,
            args.expected_workflow_run_id,
            args.verified_compose_output,
        )
    except ValueError as exc:
        raise SystemExit(f"rollback artifact verification failed: {exc}") from exc
    print("Rollback artifact verified")


if __name__ == "__main__":
    main()
