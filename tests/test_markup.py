"""Unit tests for the MarkupEngine (no server involved)."""

from pathlib import Path

import pytest

from svg_agent.markup import (
    MarkupError,
    find_by_id,
    insert_after,
    insert_before,
    prepend_transform,
    remove_attribute,
    set_attribute,
)

FIXTURE = Path(__file__).parent / "fixtures" / "scene.svg"
SOURCE = FIXTURE.read_text(encoding="utf-8")


def test_finds_nested_group_with_transform():
    ti = find_by_id(SOURCE, "fish-group")
    assert ti.tag == "g"
    assert SOURCE[ti.open_start : ti.open_end].startswith('<g id="fish-group"')


def test_finding_missing_id_raises():
    with pytest.raises(MarkupError):
        find_by_id(SOURCE, "phantom-node")


def test_set_attribute_overwrites_value_only():
    out = set_attribute(SOURCE, "eye", "cx", "999")
    assert 'cx="999"' in out
    # Other attributes on the same element survive.
    assert 'cy="-8"' in out
    assert 'r="7"' in out


def test_set_attribute_adds_when_absent():
    out = set_attribute(SOURCE, "sun", "filter", "blur(2)")
    assert 'filter="blur(2)"' in out


def test_remove_attribute_deletes_pair_and_spacer():
    out = remove_attribute(SOURCE, "body", "rx")
    bi = find_by_id(out, "body")
    opening = out[bi.open_start : bi.open_end]
    assert "rx=" not in opening
    assert 'cy="0"' in opening  # neighbouring attributes survive


def test_prepend_transform_leads_existing_stack():
    out = prepend_transform(SOURCE, "fish-group", "rotate(12)")
    gi = find_by_id(out, "fish-group")
    opening = out[gi.open_start : gi.open_end]
    assert "rotate(12) translate(60,120)" in opening


def test_insert_before_target_is_prefix_neighbour():
    out = insert_before(SOURCE, "sun", '<circle id="cloud" cx="40" cy="30"/>')
    sun_idx = out.index('id="sun"')
    cloud_idx = out.index('id="cloud"')
    assert cloud_idx < sun_idx


def test_insert_after_appears_post_subtree():
    out = insert_after(SOURCE, "fish-group", '<rect id="shadow" x="0" y="158"/>')
    grp_end = out.index("</g>") + len("</g>")
    shadow_idx = out.index('id="shadow"')
    assert shadow_idx > grp_end


def test_scalar_bytes_outside_target_remain_intact():
    watermark = "<!-- Scene fixture for MarkupEngine unit tests -->"
    out = set_attribute(SOURCE, "eye", "r", "9")
    assert watermark in out
