import hashlib
import json
import stat
from types import SimpleNamespace

import pytest
import verify_rollback_artifact as verifier
from verify_rollback_artifact import (
    ARCHIVE_NAME,
    CHECKSUM_NAME,
    CLOUDFLARED_ARCHIVE_NAME,
    CLOUDFLARED_SBOM_NAME,
    COMPOSE_NAME,
    IMAGE_REPOSITORY,
    MANIFEST_NAME,
    SBOM_NAME,
    verify_rollback_artifact,
)

RELEASE_COMMIT = "a" * 40
WORKFLOW_RUN_ID = "123456789"
IMAGE_ID = "sha256:" + "b" * 64
CLOUDFLARED_IMAGE_ID = "sha256:" + "c" * 64
CLOUDFLARED_IMAGE = "cloudflare/cloudflared:latest@sha256:" + "d" * 64


def artifact_bundle(tmp_path):
    archive = tmp_path / ARCHIVE_NAME
    archive.write_bytes(b"verified rollback image archive")
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    cloudflared_archive = tmp_path / CLOUDFLARED_ARCHIVE_NAME
    cloudflared_archive.write_bytes(b"verified cloudflared image archive")
    cloudflared_digest = hashlib.sha256(cloudflared_archive.read_bytes()).hexdigest()
    sbom = tmp_path / SBOM_NAME
    sbom.write_text(
        json.dumps(
            {
                "bomFormat": "CycloneDX",
                "specVersion": "1.6",
                "version": 1,
                "metadata": {
                    "component": {
                        "type": "container",
                        "name": "connectwise-legacy-rollback-ci",
                        "properties": [
                            {
                                "name": "aquasecurity:trivy:ImageID",
                                "value": IMAGE_ID,
                            }
                        ],
                    }
                },
                "components": [{"type": "library", "name": "example"}],
            },
            separators=(",", ":"),
        )
        + "\n",
        encoding="utf-8",
    )
    sbom_digest = hashlib.sha256(sbom.read_bytes()).hexdigest()
    cloudflared_sbom = tmp_path / CLOUDFLARED_SBOM_NAME
    cloudflared_sbom.write_text(
        json.dumps(
            {
                "bomFormat": "CycloneDX",
                "specVersion": "1.6",
                "version": 1,
                "metadata": {
                    "component": {
                        "type": "container",
                        "name": "cloudflared",
                        "properties": [
                            {
                                "name": "aquasecurity:trivy:ImageID",
                                "value": CLOUDFLARED_IMAGE_ID,
                            },
                            {
                                "name": "aquasecurity:trivy:RepoDigest",
                                "value": CLOUDFLARED_IMAGE.replace(":latest@", "@", 1),
                            },
                        ],
                    }
                },
                "components": [{"type": "application", "name": "cloudflared"}],
            },
            separators=(",", ":"),
        )
        + "\n",
        encoding="utf-8",
    )
    cloudflared_sbom_digest = hashlib.sha256(cloudflared_sbom.read_bytes()).hexdigest()
    compose = tmp_path / COMPOSE_NAME
    compose.write_text(
        "services:\n"
        "  mcp-gateway:\n"
        '    image: "${MCP_GATEWAY_IMAGE}"\n'
        "  cloudflared:\n"
        f"    image: ${{CLOUDFLARED_IMAGE:-{CLOUDFLARED_IMAGE}}}\n",
        encoding="utf-8",
    )
    compose_digest = hashlib.sha256(compose.read_bytes()).hexdigest()
    manifest = {
        "schemaVersion": 5,
        "releaseCommit": RELEASE_COMMIT,
        "workflowRunId": WORKFLOW_RUN_ID,
        "imageRepository": IMAGE_REPOSITORY,
        "imageId": IMAGE_ID,
        "archive": ARCHIVE_NAME,
        "archiveSha256": digest,
        "cloudflaredImage": CLOUDFLARED_IMAGE,
        "cloudflaredImageId": CLOUDFLARED_IMAGE_ID,
        "cloudflaredArchive": CLOUDFLARED_ARCHIVE_NAME,
        "cloudflaredArchiveSha256": cloudflared_digest,
        "sbom": SBOM_NAME,
        "sbomSha256": sbom_digest,
        "cloudflaredSbom": CLOUDFLARED_SBOM_NAME,
        "cloudflaredSbomSha256": cloudflared_sbom_digest,
        "compose": COMPOSE_NAME,
        "composeSha256": compose_digest,
    }
    (tmp_path / MANIFEST_NAME).write_text(
        json.dumps(manifest, separators=(",", ":")) + "\n", encoding="utf-8"
    )
    (tmp_path / CHECKSUM_NAME).write_text(
        f"{digest}  {ARCHIVE_NAME}\n"
        f"{cloudflared_digest}  {CLOUDFLARED_ARCHIVE_NAME}\n",
        encoding="ascii",
    )
    return manifest


def write_manifest(tmp_path, manifest):
    (tmp_path / MANIFEST_NAME).write_text(
        json.dumps(manifest, separators=(",", ":")) + "\n", encoding="utf-8"
    )


def write_bound_compose(tmp_path, manifest, content):
    compose = tmp_path / COMPOSE_NAME
    compose.write_text(content, encoding="utf-8")
    manifest["composeSha256"] = hashlib.sha256(compose.read_bytes()).hexdigest()
    write_manifest(tmp_path, manifest)


def test_accepts_exact_bound_artifact_bundle(tmp_path):
    expected = artifact_bundle(tmp_path)

    assert (
        verify_rollback_artifact(tmp_path, RELEASE_COMMIT, WORKFLOW_RUN_ID) == expected
    )


def test_writes_exact_verified_outputs_to_new_private_files(tmp_path):
    artifact_bundle(tmp_path)
    private_directory = tmp_path / "private"
    private_directory.mkdir(mode=0o700)
    compose_output = private_directory / "verified-compose.yml"
    archive_output = private_directory / "verified-archive.tar.gz"
    image_id_output = private_directory / "verified-image-id"
    cloudflared_archive_output = private_directory / "verified-cloudflared.tar.gz"
    cloudflared_image_id_output = private_directory / "verified-cloudflared-image-id"
    cloudflared_image_output = private_directory / "verified-cloudflared-image"

    verify_rollback_artifact(
        tmp_path,
        RELEASE_COMMIT,
        WORKFLOW_RUN_ID,
        verified_compose_output=compose_output,
        verified_archive_output=archive_output,
        verified_image_id_output=image_id_output,
        verified_cloudflared_archive_output=cloudflared_archive_output,
        verified_cloudflared_image_id_output=cloudflared_image_id_output,
        verified_cloudflared_image_output=cloudflared_image_output,
    )

    assert compose_output.read_bytes() == (tmp_path / COMPOSE_NAME).read_bytes()
    assert archive_output.read_bytes() == (tmp_path / ARCHIVE_NAME).read_bytes()
    assert image_id_output.read_text(encoding="ascii") == f"{IMAGE_ID}\n"
    assert cloudflared_archive_output.read_bytes() == (
        tmp_path / CLOUDFLARED_ARCHIVE_NAME
    ).read_bytes()
    assert (
        cloudflared_image_id_output.read_text(encoding="ascii")
        == f"{CLOUDFLARED_IMAGE_ID}\n"
    )
    assert (
        cloudflared_image_output.read_text(encoding="ascii")
        == f"{CLOUDFLARED_IMAGE}\n"
    )
    for output in (
        compose_output,
        archive_output,
        image_id_output,
        cloudflared_archive_output,
        cloudflared_image_id_output,
        cloudflared_image_output,
    ):
        assert stat.S_IMODE(output.stat().st_mode) == 0o400


def test_removes_all_new_outputs_when_later_output_already_exists(tmp_path):
    artifact_bundle(tmp_path)
    private_directory = tmp_path / "private"
    private_directory.mkdir(mode=0o700)
    compose_output = private_directory / "verified-compose.yml"
    archive_output = private_directory / "verified-archive.tar.gz"
    image_id_output = private_directory / "verified-image-id"
    cloudflared_archive_output = private_directory / "verified-cloudflared.tar.gz"
    cloudflared_image_id_output = private_directory / "verified-cloudflared-image-id"
    cloudflared_image_output = private_directory / "existing-cloudflared-image"
    cloudflared_image_output.write_text("do not replace\n", encoding="ascii")

    with pytest.raises(ValueError, match="must not already exist"):
        verify_rollback_artifact(
            tmp_path,
            RELEASE_COMMIT,
            WORKFLOW_RUN_ID,
            verified_compose_output=compose_output,
            verified_archive_output=archive_output,
            verified_image_id_output=image_id_output,
            verified_cloudflared_archive_output=cloudflared_archive_output,
            verified_cloudflared_image_id_output=cloudflared_image_id_output,
            verified_cloudflared_image_output=cloudflared_image_output,
        )

    for output in (
        compose_output,
        archive_output,
        image_id_output,
        cloudflared_archive_output,
        cloudflared_image_id_output,
    ):
        assert not output.exists()
    assert cloudflared_image_output.read_text(encoding="ascii") == "do not replace\n"


def test_private_outputs_survive_download_path_replacement(tmp_path):
    manifest = artifact_bundle(tmp_path)
    private_directory = tmp_path / "private"
    private_directory.mkdir(mode=0o700)
    compose_output = private_directory / "verified-compose.yml"
    archive_output = private_directory / "verified-archive.tar.gz"
    image_id_output = private_directory / "verified-image-id"

    verify_rollback_artifact(
        tmp_path,
        RELEASE_COMMIT,
        WORKFLOW_RUN_ID,
        verified_compose_output=compose_output,
        verified_archive_output=archive_output,
        verified_image_id_output=image_id_output,
    )
    (tmp_path / ARCHIVE_NAME).write_bytes(b"substituted archive")
    manifest["imageId"] = "sha256:" + "c" * 64
    write_manifest(tmp_path, manifest)

    assert archive_output.read_bytes() == b"verified rollback image archive"
    assert image_id_output.read_text(encoding="ascii") == f"{IMAGE_ID}\n"


def test_rejects_existing_verified_compose_output(tmp_path):
    artifact_bundle(tmp_path)
    output = tmp_path / "existing.yml"
    output.write_text("do not replace\n", encoding="utf-8")

    with pytest.raises(ValueError, match="must not already exist"):
        verify_rollback_artifact(
            tmp_path, RELEASE_COMMIT, WORKFLOW_RUN_ID, verified_compose_output=output
        )
    assert output.read_text(encoding="utf-8") == "do not replace\n"


def test_rejects_symlinked_verified_compose_output_parent(tmp_path):
    artifact_bundle(tmp_path)
    real_directory = tmp_path / "real-private"
    real_directory.mkdir()
    linked_directory = tmp_path / "linked-private"
    linked_directory.symlink_to(real_directory, target_is_directory=True)

    with pytest.raises(ValueError, match="non-symlink directory"):
        verify_rollback_artifact(
            tmp_path,
            RELEASE_COMMIT,
            WORKFLOW_RUN_ID,
            verified_compose_output=linked_directory / "verified-compose.yml",
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
        ("cloudflaredImage", "cloudflare/cloudflared:latest", "cloudflaredImage"),
        ("cloudflaredImageId", "c" * 64, "cloudflaredImageId"),
        ("cloudflaredArchive", "renamed-cloudflared.tar.gz", "cloudflaredArchive"),
        (
            "cloudflaredArchiveSha256",
            "A" * 64,
            "cloudflaredArchiveSha256",
        ),
        ("sbom", "renamed.cdx.json", "sbom"),
        ("sbomSha256", "A" * 64, "sbomSha256"),
        ("cloudflaredSbom", "renamed-cloudflared.cdx.json", "cloudflaredSbom"),
        ("cloudflaredSbomSha256", "A" * 64, "cloudflaredSbomSha256"),
        ("compose", "renamed.yml", "compose"),
        ("composeSha256", "A" * 64, "composeSha256"),
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
    (tmp_path / CHECKSUM_NAME).write_text(checksum.replace("  ", " "), encoding="ascii")

    with pytest.raises(ValueError, match="Checksum file"):
        verify_rollback_artifact(tmp_path, RELEASE_COMMIT, WORKFLOW_RUN_ID)


def test_rejects_archive_digest_mismatch_and_removes_partial_private_copy(tmp_path):
    artifact_bundle(tmp_path)
    (tmp_path / ARCHIVE_NAME).write_bytes(b"tampered")
    private_directory = tmp_path / "private"
    private_directory.mkdir(mode=0o700)
    archive_output = private_directory / "verified-archive.tar.gz"

    with pytest.raises(ValueError, match="SHA-256 mismatch"):
        verify_rollback_artifact(
            tmp_path,
            RELEASE_COMMIT,
            WORKFLOW_RUN_ID,
            verified_archive_output=archive_output,
        )
    assert not archive_output.exists()


def test_rejects_cloudflared_archive_digest_mismatch_and_removes_outputs(tmp_path):
    artifact_bundle(tmp_path)
    (tmp_path / CLOUDFLARED_ARCHIVE_NAME).write_bytes(b"tampered")
    private_directory = tmp_path / "private"
    private_directory.mkdir(mode=0o700)
    archive_output = private_directory / "verified-archive.tar.gz"
    cloudflared_output = private_directory / "verified-cloudflared.tar.gz"

    with pytest.raises(ValueError, match="Cloudflared image archive SHA-256 mismatch"):
        verify_rollback_artifact(
            tmp_path,
            RELEASE_COMMIT,
            WORKFLOW_RUN_ID,
            verified_archive_output=archive_output,
            verified_cloudflared_archive_output=cloudflared_output,
        )
    assert not archive_output.exists()
    assert not cloudflared_output.exists()


def test_rejects_sbom_digest_mismatch_and_removes_archive_output(tmp_path):
    artifact_bundle(tmp_path)
    (tmp_path / SBOM_NAME).write_text(
        '{"bomFormat":"CycloneDX","specVersion":"1.6","version":1,"components":[]}\n',
        encoding="utf-8",
    )
    private_directory = tmp_path / "private"
    private_directory.mkdir(mode=0o700)
    archive_output = private_directory / "verified-archive.tar.gz"

    with pytest.raises(ValueError, match="SBOM SHA-256 mismatch"):
        verify_rollback_artifact(
            tmp_path,
            RELEASE_COMMIT,
            WORKFLOW_RUN_ID,
            verified_archive_output=archive_output,
        )
    assert not archive_output.exists()


def test_rejects_cloudflared_sbom_digest_mismatch(tmp_path):
    artifact_bundle(tmp_path)
    (tmp_path / CLOUDFLARED_SBOM_NAME).write_text(
        '{"bomFormat":"CycloneDX","specVersion":"1.6","version":1,"components":[]}\n',
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="Cloudflared image SBOM SHA-256 mismatch"):
        verify_rollback_artifact(tmp_path, RELEASE_COMMIT, WORKFLOW_RUN_ID)


@pytest.mark.parametrize(
    ("sbom_name", "sha_field", "properties", "message"),
    [
        (SBOM_NAME, "sbomSha256", [], "image ID"),
        (
            SBOM_NAME,
            "sbomSha256",
            [
                {"name": "aquasecurity:trivy:ImageID", "value": "sha256:" + "0" * 64}
            ],
            "image ID",
        ),
        (
            SBOM_NAME,
            "sbomSha256",
            [
                {"name": "aquasecurity:trivy:ImageID", "value": IMAGE_ID},
                {"name": "aquasecurity:trivy:ImageID", "value": IMAGE_ID},
            ],
            "image ID",
        ),
        (
            CLOUDFLARED_SBOM_NAME,
            "cloudflaredSbomSha256",
            [{"name": "aquasecurity:trivy:ImageID", "value": CLOUDFLARED_IMAGE_ID}],
            "repository digest",
        ),
        (
            CLOUDFLARED_SBOM_NAME,
            "cloudflaredSbomSha256",
            [
                {"name": "aquasecurity:trivy:ImageID", "value": CLOUDFLARED_IMAGE_ID},
                {
                    "name": "aquasecurity:trivy:RepoDigest",
                    "value": "cloudflare/cloudflared@sha256:" + "0" * 64,
                },
            ],
            "repository digest",
        ),
        (
            CLOUDFLARED_SBOM_NAME,
            "cloudflaredSbomSha256",
            [
                {"name": "aquasecurity:trivy:ImageID", "value": CLOUDFLARED_IMAGE_ID},
                {
                    "name": "aquasecurity:trivy:RepoDigest",
                    "value": CLOUDFLARED_IMAGE.replace(":latest@", "@", 1),
                },
                {
                    "name": "aquasecurity:trivy:RepoDigest",
                    "value": CLOUDFLARED_IMAGE.replace(":latest@", "@", 1),
                },
            ],
            "repository digest",
        ),
    ],
)
def test_rejects_unbound_or_ambiguous_sbom_identity(
    tmp_path, sbom_name, sha_field, properties, message
):
    manifest = artifact_bundle(tmp_path)
    sbom_path = tmp_path / sbom_name
    sbom = json.loads(sbom_path.read_text(encoding="utf-8"))
    sbom["metadata"]["component"]["properties"] = properties
    sbom_path.write_text(json.dumps(sbom, separators=(",", ":")) + "\n", encoding="utf-8")
    manifest[sha_field] = hashlib.sha256(sbom_path.read_bytes()).hexdigest()
    write_manifest(tmp_path, manifest)

    with pytest.raises(ValueError, match=message):
        verify_rollback_artifact(tmp_path, RELEASE_COMMIT, WORKFLOW_RUN_ID)


def test_rejects_swapped_sboms_even_when_manifest_hashes_are_updated(tmp_path):
    manifest = artifact_bundle(tmp_path)
    gateway_path = tmp_path / SBOM_NAME
    cloudflared_path = tmp_path / CLOUDFLARED_SBOM_NAME
    gateway_bytes = gateway_path.read_bytes()
    cloudflared_bytes = cloudflared_path.read_bytes()
    gateway_path.write_bytes(cloudflared_bytes)
    cloudflared_path.write_bytes(gateway_bytes)
    manifest["sbomSha256"] = hashlib.sha256(cloudflared_bytes).hexdigest()
    manifest["cloudflaredSbomSha256"] = hashlib.sha256(gateway_bytes).hexdigest()
    write_manifest(tmp_path, manifest)

    with pytest.raises(ValueError, match="image ID does not match"):
        verify_rollback_artifact(tmp_path, RELEASE_COMMIT, WORKFLOW_RUN_ID)


def test_rejects_sbom_without_container_root(tmp_path):
    manifest = artifact_bundle(tmp_path)
    sbom_path = tmp_path / SBOM_NAME
    sbom = json.loads(sbom_path.read_text(encoding="utf-8"))
    sbom["metadata"]["component"]["type"] = "application"
    sbom_path.write_text(json.dumps(sbom, separators=(",", ":")) + "\n", encoding="utf-8")
    manifest["sbomSha256"] = hashlib.sha256(sbom_path.read_bytes()).hexdigest()
    write_manifest(tmp_path, manifest)

    with pytest.raises(ValueError, match="scanned container image"):
        verify_rollback_artifact(tmp_path, RELEASE_COMMIT, WORKFLOW_RUN_ID)


@pytest.mark.parametrize(
    ("sbom_name", "sha_field", "label"),
    [
        (SBOM_NAME, "sbomSha256", "Rollback image SBOM"),
        (
            CLOUDFLARED_SBOM_NAME,
            "cloudflaredSbomSha256",
            "Cloudflared image SBOM",
        ),
    ],
)
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
def test_rejects_invalid_cyclonedx_inventory(
    tmp_path, invalid_sbom, sbom_name, sha_field, label
):
    manifest = artifact_bundle(tmp_path)
    sbom = tmp_path / sbom_name
    sbom.write_text(json.dumps(invalid_sbom) + "\n", encoding="utf-8")
    manifest[sha_field] = hashlib.sha256(sbom.read_bytes()).hexdigest()
    write_manifest(tmp_path, manifest)

    with pytest.raises(ValueError, match=f"{label} must be a valid"):
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


def test_rejects_compose_digest_mismatch(tmp_path):
    artifact_bundle(tmp_path)
    (tmp_path / COMPOSE_NAME).write_text("services: {}\n", encoding="utf-8")

    with pytest.raises(ValueError, match="Compose file SHA-256 mismatch"):
        verify_rollback_artifact(tmp_path, RELEASE_COMMIT, WORKFLOW_RUN_ID)


def test_rejects_manifest_cloudflared_image_not_bound_to_compose(tmp_path):
    manifest = artifact_bundle(tmp_path)
    manifest["cloudflaredImage"] = "cloudflare/cloudflared:latest@sha256:" + "e" * 64
    write_manifest(tmp_path, manifest)

    with pytest.raises(ValueError, match="repository digest does not match"):
        verify_rollback_artifact(tmp_path, RELEASE_COMMIT, WORKFLOW_RUN_ID)


def test_rejects_compose_without_cloudflared_service(tmp_path):
    manifest = artifact_bundle(tmp_path)
    write_bound_compose(
        tmp_path,
        manifest,
        "services:\n  mcp-gateway:\n    image: rollback\n",
    )

    with pytest.raises(ValueError, match="exactly one cloudflared service"):
        verify_rollback_artifact(tmp_path, RELEASE_COMMIT, WORKFLOW_RUN_ID)


def test_rejects_cloudflared_decoy_outside_services(tmp_path):
    manifest = artifact_bundle(tmp_path)
    write_bound_compose(
        tmp_path,
        manifest,
        "x-decoy:\n"
        "  cloudflared:\n"
        f"    image: ${{CLOUDFLARED_IMAGE:-{CLOUDFLARED_IMAGE}}}\n"
        "services:\n"
        "  mcp-gateway:\n"
        "    image: rollback\n",
    )

    with pytest.raises(ValueError, match="exactly one cloudflared service"):
        verify_rollback_artifact(tmp_path, RELEASE_COMMIT, WORKFLOW_RUN_ID)


def test_checked_in_compose_binds_cloudflared_manifest_reference():
    compose = verifier.Path(__file__).parents[1] / "docker-compose.yml"
    checked_in_image = (
        "cloudflare/cloudflared:latest@sha256:"
        "faa8e0a1475f137c910be6025f43c8e4092fdd35461b31e19fd1390657a1ff39"
    )

    verifier._verify_compose_cloudflared_image(compose.read_bytes(), checked_in_image)


@pytest.mark.parametrize(
    "decoy",
    [
        f"  # cloudflared:\n  #   image: ${{CLOUDFLARED_IMAGE:-{CLOUDFLARED_IMAGE}}}\n",
        f"  other:\n    image: ${{CLOUDFLARED_IMAGE:-{CLOUDFLARED_IMAGE}}}\n",
        f"  cloudflared:\n    command: echo ${{CLOUDFLARED_IMAGE:-{CLOUDFLARED_IMAGE}}}\n",
    ],
)
def test_rejects_cloudflared_reference_only_in_comment_or_unrelated_field(
    tmp_path, decoy
):
    manifest = artifact_bundle(tmp_path)
    write_bound_compose(tmp_path, manifest, f"services:\n{decoy}")

    with pytest.raises(
        ValueError, match="cloudflared service|image default does not match"
    ):
        verify_rollback_artifact(tmp_path, RELEASE_COMMIT, WORKFLOW_RUN_ID)


def test_rejects_empty_compose(tmp_path):
    manifest = artifact_bundle(tmp_path)
    compose = tmp_path / COMPOSE_NAME
    compose.write_bytes(b"")
    manifest["composeSha256"] = hashlib.sha256(b"").hexdigest()
    write_manifest(tmp_path, manifest)

    with pytest.raises(ValueError, match="must not be empty"):
        verify_rollback_artifact(tmp_path, RELEASE_COMMIT, WORKFLOW_RUN_ID)


def test_rejects_oversized_compose(tmp_path, monkeypatch):
    manifest = artifact_bundle(tmp_path)
    compose = tmp_path / COMPOSE_NAME
    compose.write_bytes(b"123456789")
    manifest["composeSha256"] = hashlib.sha256(compose.read_bytes()).hexdigest()
    write_manifest(tmp_path, manifest)
    monkeypatch.setattr(verifier, "MAX_COMPOSE_BYTES", 8)

    with pytest.raises(ValueError, match="maximum allowed size"):
        verify_rollback_artifact(tmp_path, RELEASE_COMMIT, WORKFLOW_RUN_ID)


@pytest.mark.parametrize(
    "name",
    [
        ARCHIVE_NAME,
        CLOUDFLARED_ARCHIVE_NAME,
        CHECKSUM_NAME,
        MANIFEST_NAME,
        SBOM_NAME,
        CLOUDFLARED_SBOM_NAME,
        COMPOSE_NAME,
    ],
)
def test_rejects_missing_required_file(tmp_path, name):
    artifact_bundle(tmp_path)
    (tmp_path / name).unlink()

    with pytest.raises(ValueError, match="Missing required"):
        verify_rollback_artifact(tmp_path, RELEASE_COMMIT, WORKFLOW_RUN_ID)


@pytest.mark.parametrize(
    "name",
    [
        ARCHIVE_NAME,
        CLOUDFLARED_ARCHIVE_NAME,
        CHECKSUM_NAME,
        MANIFEST_NAME,
        SBOM_NAME,
        CLOUDFLARED_SBOM_NAME,
        COMPOSE_NAME,
    ],
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
    "name",
    [
        ARCHIVE_NAME,
        CLOUDFLARED_ARCHIVE_NAME,
        CHECKSUM_NAME,
        MANIFEST_NAME,
        SBOM_NAME,
        CLOUDFLARED_SBOM_NAME,
        COMPOSE_NAME,
    ],
)
def test_rejects_hardlinked_artifact_file(tmp_path, name):
    artifact_bundle(tmp_path)
    path = tmp_path / name
    external_alias = tmp_path.parent / f"{tmp_path.name}-{name}.alias"
    external_alias.hardlink_to(path)

    with pytest.raises(ValueError, match="single-link"):
        verify_rollback_artifact(tmp_path, RELEASE_COMMIT, WORKFLOW_RUN_ID)
