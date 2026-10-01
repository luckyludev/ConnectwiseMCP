import hashlib
import json

import pytest

from verify_rollback_artifact import (
    ARCHIVE_NAME,
    CHECKSUM_NAME,
    IMAGE_REPOSITORY,
    MANIFEST_NAME,
    verify_rollback_artifact,
)

RELEASE_COMMIT = "a" * 40
WORKFLOW_RUN_ID = "123456789"
IMAGE_ID = "sha256:" + "b" * 64


def artifact_bundle(tmp_path):
    archive = tmp_path / ARCHIVE_NAME
    archive.write_bytes(b"verified rollback image archive")
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    manifest = {
        "schemaVersion": 1,
        "releaseCommit": RELEASE_COMMIT,
        "workflowRunId": WORKFLOW_RUN_ID,
        "imageRepository": IMAGE_REPOSITORY,
        "imageId": IMAGE_ID,
        "archive": ARCHIVE_NAME,
        "archiveSha256": digest,
    }
    (tmp_path / MANIFEST_NAME).write_text(
        json.dumps(manifest, separators=(",", ":")) + "\n", encoding="utf-8"
    )
    (tmp_path / CHECKSUM_NAME).write_text(
        f"{digest}  {ARCHIVE_NAME}\n", encoding="ascii"
    )
    return manifest


def write_manifest(tmp_path, manifest):
    (tmp_path / MANIFEST_NAME).write_text(
        json.dumps(manifest, separators=(",", ":")) + "\n", encoding="utf-8"
    )


def test_accepts_exact_bound_artifact_bundle(tmp_path):
    expected = artifact_bundle(tmp_path)

    assert (
        verify_rollback_artifact(tmp_path, RELEASE_COMMIT, WORKFLOW_RUN_ID) == expected
    )


@pytest.mark.parametrize(
    ("release_commit", "run_id", "message"),
    [
        ("c" * 40, WORKFLOW_RUN_ID, "releaseCommit"),
        (RELEASE_COMMIT, "987654321", "workflowRunId"),
        ("A" * 40, WORKFLOW_RUN_ID, "40 lowercase"),
        (RELEASE_COMMIT, "0", "positive decimal"),
    ],
)
def test_rejects_invalid_or_stale_expected_bindings(
    tmp_path, release_commit, run_id, message
):
    artifact_bundle(tmp_path)

    with pytest.raises(ValueError, match=message):
        verify_rollback_artifact(tmp_path, release_commit, run_id)


@pytest.mark.parametrize(
    ("field", "value", "message"),
    [
        ("schemaVersion", 2, "schemaVersion"),
        ("releaseCommit", "c" * 40, "releaseCommit"),
        ("workflowRunId", "987654321", "workflowRunId"),
        ("imageRepository", "other/image", "imageRepository"),
        ("imageId", "b" * 64, "imageId"),
        ("archive", "renamed.tar.gz", "archive"),
        ("archiveSha256", "A" * 64, "archiveSha256"),
    ],
)
def test_rejects_invalid_manifest_values(tmp_path, field, value, message):
    manifest = artifact_bundle(tmp_path)
    manifest[field] = value
    write_manifest(tmp_path, manifest)

    with pytest.raises(ValueError, match=message):
        verify_rollback_artifact(tmp_path, RELEASE_COMMIT, WORKFLOW_RUN_ID)


@pytest.mark.parametrize("change", ["missing", "extra"])
def test_rejects_non_exact_manifest_schema(tmp_path, change):
    manifest = artifact_bundle(tmp_path)
    if change == "missing":
        del manifest["imageId"]
    else:
        manifest["unexpected"] = "value"
    write_manifest(tmp_path, manifest)

    with pytest.raises(ValueError, match="exactly"):
        verify_rollback_artifact(tmp_path, RELEASE_COMMIT, WORKFLOW_RUN_ID)


def test_rejects_malformed_checksum_file(tmp_path):
    artifact_bundle(tmp_path)
    checksum = (tmp_path / CHECKSUM_NAME).read_text(encoding="ascii")
    (tmp_path / CHECKSUM_NAME).write_text(
        checksum.replace("  ", " "), encoding="ascii"
    )

    with pytest.raises(ValueError, match="Checksum file"):
        verify_rollback_artifact(tmp_path, RELEASE_COMMIT, WORKFLOW_RUN_ID)


def test_rejects_archive_digest_mismatch(tmp_path):
    artifact_bundle(tmp_path)
    (tmp_path / ARCHIVE_NAME).write_bytes(b"tampered")

    with pytest.raises(ValueError, match="SHA-256 mismatch"):
        verify_rollback_artifact(tmp_path, RELEASE_COMMIT, WORKFLOW_RUN_ID)


@pytest.mark.parametrize("name", [ARCHIVE_NAME, CHECKSUM_NAME, MANIFEST_NAME])
def test_rejects_missing_required_file(tmp_path, name):
    artifact_bundle(tmp_path)
    (tmp_path / name).unlink()

    with pytest.raises(ValueError, match="Missing required"):
        verify_rollback_artifact(tmp_path, RELEASE_COMMIT, WORKFLOW_RUN_ID)


@pytest.mark.parametrize("name", [ARCHIVE_NAME, CHECKSUM_NAME, MANIFEST_NAME])
def test_rejects_symlinked_artifact_file(tmp_path, name):
    artifact_bundle(tmp_path)
    path = tmp_path / name
    target = tmp_path / f"{name}.target"
    path.rename(target)
    path.symlink_to(target.name)

    with pytest.raises(ValueError, match="non-symlink"):
        verify_rollback_artifact(tmp_path, RELEASE_COMMIT, WORKFLOW_RUN_ID)


@pytest.mark.parametrize("name", [ARCHIVE_NAME, CHECKSUM_NAME, MANIFEST_NAME])
def test_rejects_hardlinked_artifact_file(tmp_path, name):
    artifact_bundle(tmp_path)
    path = tmp_path / name
    external_alias = tmp_path.parent / f"{tmp_path.name}-{name}.alias"
    external_alias.hardlink_to(path)

    with pytest.raises(ValueError, match="single-link"):
        verify_rollback_artifact(tmp_path, RELEASE_COMMIT, WORKFLOW_RUN_ID)
