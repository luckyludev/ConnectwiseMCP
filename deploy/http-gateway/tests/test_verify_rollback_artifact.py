import hashlib
import json
import stat
from types import SimpleNamespace

import pytest
import verify_rollback_artifact as verifier

from verify_rollback_artifact import (
    ARCHIVE_NAME,
    CHECKSUM_NAME,
    IMAGE_REPOSITORY,
    MANIFEST_NAME,
    SBOM_NAME,
    verify_rollback_artifact,
)

RELEASE_COMMIT = "a" * 40
WORKFLOW_RUN_ID = "123456789"
IMAGE_ID = "sha256:" + "b" * 64


def artifact_bundle(tmp_path):
    archive = tmp_path / ARCHIVE_NAME
    archive.write_bytes(b"verified rollback image archive")
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    sbom = tmp_path / SBOM_NAME
    sbom.write_text(
        json.dumps(
            {
                "bomFormat": "CycloneDX",
                "specVersion": "1.6",
                "version": 1,
                "components": [{"type": "library", "name": "example"}],
            },
            separators=(",", ":"),
        )
        + "\n",
        encoding="utf-8",
    )
    sbom_digest = hashlib.sha256(sbom.read_bytes()).hexdigest()
    manifest = {
        "schemaVersion": 2,
        "releaseCommit": RELEASE_COMMIT,
        "workflowRunId": WORKFLOW_RUN_ID,
        "imageRepository": IMAGE_REPOSITORY,
        "imageId": IMAGE_ID,
        "archive": ARCHIVE_NAME,
        "archiveSha256": digest,
        "sbom": SBOM_NAME,
        "sbomSha256": sbom_digest,
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


def test_rejects_symlinked_artifact_directory(tmp_path):
    artifact_directory = tmp_path / "artifact"
    artifact_directory.mkdir()
    artifact_bundle(artifact_directory)
    symlink = tmp_path / "artifact-link"
    symlink.symlink_to(artifact_directory, target_is_directory=True)

    with pytest.raises(ValueError, match="non-symlink directory"):
        verify_rollback_artifact(symlink, RELEASE_COMMIT, WORKFLOW_RUN_ID)


def test_rejects_path_below_regular_file_without_traceback(tmp_path):
    parent_file = tmp_path / "not-a-directory"
    parent_file.write_text("not a directory", encoding="utf-8")

    with pytest.raises(ValueError, match="does not exist or is not a directory"):
        verify_rollback_artifact(
            parent_file / "artifact", RELEASE_COMMIT, WORKFLOW_RUN_ID
        )


def test_rejects_fifo_without_blocking(tmp_path):
    artifact_bundle(tmp_path)
    manifest_path = tmp_path / MANIFEST_NAME
    manifest_path.unlink()
    verifier.os.mkfifo(manifest_path)

    with pytest.raises(ValueError, match="regular non-symlink single-link"):
        verify_rollback_artifact(tmp_path, RELEASE_COMMIT, WORKFLOW_RUN_ID)


def test_rejects_file_path_replacement_after_descriptor_open(tmp_path, monkeypatch):
    artifact_bundle(tmp_path)
    manifest_path = tmp_path / MANIFEST_NAME
    manifest_inode = manifest_path.stat().st_ino
    original_path = tmp_path / f"{MANIFEST_NAME}.original"
    replacement_path = tmp_path / f"{MANIFEST_NAME}.replacement"
    replacement_path.write_text("{}\n", encoding="utf-8")
    real_fstat = verifier.os.fstat
    replaced = False

    def replace_after_open(descriptor):
        nonlocal replaced
        metadata = real_fstat(descriptor)
        if (
            not replaced
            and stat.S_ISREG(metadata.st_mode)
            and metadata.st_ino == manifest_inode
        ):
            manifest_path.rename(original_path)
            manifest_path.symlink_to(replacement_path.name)
            replaced = True
        return metadata

    monkeypatch.setattr(verifier.os, "fstat", replace_after_open)

    with pytest.raises(ValueError, match="changed during verification"):
        verify_rollback_artifact(tmp_path, RELEASE_COMMIT, WORKFLOW_RUN_ID)
    assert replaced


def test_rejects_metadata_change_during_descriptor_read(tmp_path, monkeypatch):
    artifact_bundle(tmp_path)
    manifest_inode = (tmp_path / MANIFEST_NAME).stat().st_ino
    real_fstat = verifier.os.fstat
    manifest_fstats = 0

    def change_ctime_on_second_fstat(descriptor):
        nonlocal manifest_fstats
        metadata = real_fstat(descriptor)
        if stat.S_ISREG(metadata.st_mode) and metadata.st_ino == manifest_inode:
            manifest_fstats += 1
            if manifest_fstats == 2:
                return SimpleNamespace(
                    st_dev=metadata.st_dev,
                    st_ino=metadata.st_ino,
                    st_mode=metadata.st_mode,
                    st_nlink=metadata.st_nlink,
                    st_size=metadata.st_size,
                    st_mtime_ns=metadata.st_mtime_ns,
                    st_ctime_ns=metadata.st_ctime_ns + 1,
                )
        return metadata

    monkeypatch.setattr(verifier.os, "fstat", change_ctime_on_second_fstat)

    with pytest.raises(ValueError, match="changed during verification"):
        verify_rollback_artifact(tmp_path, RELEASE_COMMIT, WORKFLOW_RUN_ID)


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
        ("schemaVersion", 1, "schemaVersion"),
        ("releaseCommit", "c" * 40, "releaseCommit"),
        ("workflowRunId", "987654321", "workflowRunId"),
        ("imageRepository", "other/image", "imageRepository"),
        ("imageId", "b" * 64, "imageId"),
        ("archive", "renamed.tar.gz", "archive"),
        ("archiveSha256", "A" * 64, "archiveSha256"),
        ("sbom", "renamed.cdx.json", "sbom"),
        ("sbomSha256", "A" * 64, "sbomSha256"),
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


def test_rejects_sbom_digest_mismatch(tmp_path):
    artifact_bundle(tmp_path)
    (tmp_path / SBOM_NAME).write_text(
        '{"bomFormat":"CycloneDX","specVersion":"1.6","version":1,"components":[]}\n',
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="SBOM SHA-256 mismatch"):
        verify_rollback_artifact(tmp_path, RELEASE_COMMIT, WORKFLOW_RUN_ID)


@pytest.mark.parametrize(
    "invalid_sbom",
    [
        {"bomFormat": "other", "specVersion": "1.6", "version": 1, "components": []},
        {
            "bomFormat": "CycloneDX",
            "specVersion": "garbage",
            "version": 1,
            "components": [{"type": "library", "name": "example"}],
        },
        {
            "bomFormat": "CycloneDX",
            "specVersion": "1.6",
            "version": 1,
            "components": [None],
        },
        {
            "bomFormat": "CycloneDX",
            "specVersion": "1.6",
            "version": 1,
            "components": [{"type": "library", "name": ""}],
        },
    ],
)
def test_rejects_invalid_cyclonedx_inventory(tmp_path, invalid_sbom):
    manifest = artifact_bundle(tmp_path)
    sbom = tmp_path / SBOM_NAME
    sbom.write_text(json.dumps(invalid_sbom) + "\n", encoding="utf-8")
    manifest["sbomSha256"] = hashlib.sha256(sbom.read_bytes()).hexdigest()
    write_manifest(tmp_path, manifest)

    with pytest.raises(ValueError, match="CycloneDX component inventory"):
        verify_rollback_artifact(tmp_path, RELEASE_COMMIT, WORKFLOW_RUN_ID)


def test_rejects_oversized_sbom(tmp_path, monkeypatch):
    manifest = artifact_bundle(tmp_path)
    sbom = tmp_path / SBOM_NAME
    sbom.write_bytes(b"{" + b" " * 8 + b"}")
    manifest["sbomSha256"] = hashlib.sha256(sbom.read_bytes()).hexdigest()
    write_manifest(tmp_path, manifest)
    monkeypatch.setattr(verifier, "MAX_SBOM_BYTES", 8)

    with pytest.raises(ValueError, match="maximum allowed size"):
        verify_rollback_artifact(tmp_path, RELEASE_COMMIT, WORKFLOW_RUN_ID)


@pytest.mark.parametrize(
    "name", [ARCHIVE_NAME, CHECKSUM_NAME, MANIFEST_NAME, SBOM_NAME]
)
def test_rejects_missing_required_file(tmp_path, name):
    artifact_bundle(tmp_path)
    (tmp_path / name).unlink()

    with pytest.raises(ValueError, match="Missing required"):
        verify_rollback_artifact(tmp_path, RELEASE_COMMIT, WORKFLOW_RUN_ID)


@pytest.mark.parametrize(
    "name", [ARCHIVE_NAME, CHECKSUM_NAME, MANIFEST_NAME, SBOM_NAME]
)
def test_rejects_symlinked_artifact_file(tmp_path, name):
    artifact_bundle(tmp_path)
    path = tmp_path / name
    target = tmp_path / f"{name}.target"
    path.rename(target)
    path.symlink_to(target.name)

    with pytest.raises(ValueError, match="non-symlink"):
        verify_rollback_artifact(tmp_path, RELEASE_COMMIT, WORKFLOW_RUN_ID)


@pytest.mark.parametrize(
    "name", [ARCHIVE_NAME, CHECKSUM_NAME, MANIFEST_NAME, SBOM_NAME]
)
def test_rejects_hardlinked_artifact_file(tmp_path, name):
    artifact_bundle(tmp_path)
    path = tmp_path / name
    external_alias = tmp_path.parent / f"{tmp_path.name}-{name}.alias"
    external_alias.hardlink_to(path)

    with pytest.raises(ValueError, match="single-link"):
        verify_rollback_artifact(tmp_path, RELEASE_COMMIT, WORKFLOW_RUN_ID)
