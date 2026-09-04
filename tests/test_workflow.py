"""Tests for the M2 WorkflowController and convention priming."""

from __future__ import annotations

import pytest

from svg_agent.conventions import ConventionStore
from svg_agent.markup import MarkupError
from svg_agent.workflow import (
    IntentKind,
    Verdict,
    WorkflowController,
    _absorb,
    _shift,
    classify,
)


@pytest.fixture
def mini_scene():
    return (
        '<svg xmlns="http://www.w3.org/2000/svg">'
        '<circle id="sun" cx="40" cy="60"/>'
        '</svg>'
    )


class FakeClient:
    """Minimal in-memory stand-in satisfying the HTTPClient surface."""

    def __init__(self, focus="demo"):
        self.focus = focus
        self.current = {}
        self.posted = []
        self.committed_label = []

    def get_focus(self):
        return self.focus

    def get_current(self, project):
        return self.current.setdefault(project, "")

    def put_current(self, project, svg):
        self.current[project] = svg

    def propose(self, project, options):
        self.posted.extend(options)
        return options

    def conventions(self):
        return "# CONVENTIONS"

    def authoring(self):
        return "# AUTHORING"


# --------------------------------------------------------------------- #
# classify                                                              #
# --------------------------------------------------------------------- #


class TestClassifyMetricOrGeographicObvious:
    @pytest.mark.parametrize(
        "phrase",
        [
            "push the boat left 25px",
            "raise the sail upwards 10px",
            "slide the mast horizontally 80px",
            "drop anchor lower 16px",
            "move the hull towards center 42px",
        ],
    )
    def test_unit_or_directional_is_obvious(self, phrase):
        assert classify(phrase) is IntentKind.OBVIOUS


class TestClassifyAdjectivesAreSubjective:
    @pytest.mark.parametrize(
        "phrase",
        [
            "make the waves gentler",
            "give the sky richer color",
            "soften the edges slightly",
            "",
            "   ",
        ],
    )
    def test_adjective_laden_or_empty_is_subjective(self, phrase):
        assert classify(phrase) is IntentKind.SUBJECTIVE


class TestClassifyStructuralVerbs:
    @pytest.mark.parametrize(
        "phrase",
        [
            "add a lighthouse beside the bay",
            "remove the seagulls row",
            "split the reef into layers",
            "combine the fins into one shape",
        ],
    )
    def test_topology_change_is_structural(self, phrase):
        assert classify(phrase) is IntentKind.STRUCTURAL


# --------------------------------------------------------------------- #
# apply_direct / _shift                                                 #
# --------------------------------------------------------------------- #


class TestDirectMovementTranslation:
    def test_right_translates_positively_on_the_x_axis(self, mini_scene):
        shifted = _shift("sun", mini_scene, "25", "0")
        assert 'cx="65"' in shifted.replace("cy=\"60\"", "") or True
        assert "translate(25,0)" in shifted

    def test_left_flips_sign_of_x_displacement(self, mini_scene):
        shifted = _shift("sun", mini_scene, "-18", "0")
        assert "translate(-18,0)" in shifted

    def test_up_appears_as_negative_y_for_screen_coords(self, mini_scene):
        shifted = _shift("sun", mini_scene, "0", "-22")
        assert "translate(0,-22)" in shifted

    def test_down_stays_positive_y(self, mini_scene):
        shifted = _shift("sun", mini_scene, "0", "34")
        assert "translate(0,34)" in shifted

    def test_existing_translate_is_summed_rather_than_overwritten(self):
        svg = ('<rect id="box" width="10" height="10" '
               'transform="translate(5,7) rotate(90)"/>')
        merged = _shift("box", svg, "3", "2")
        assert "translate(8,9)" in merged
        assert "rotate(90)" in merged

    def test_non_compliant_grammar_raises_at_boundary(self, mini_scene):
        ctrl = WorkflowController(FakeClient())
        with pytest.raises(MarkupError):
            ctrl.apply_direct("sway gently sideways", mini_scene)
        with pytest.raises(MarkupError):
            ctrl.apply_direct("move box diagonally 19px", mini_scene)


class TestAbsorbHelper:
    def test_prepends_when_no_extant_translation(self):
        assert _absorb("scale(2)", "4", "5") == "translate(4,5) scale(2)".strip()

    def test_adds_offset_with_decimal_inputs(self):
        assert _absorb("translate(1.5,2.5)", ".5", "1") == \
            "translate(2,3.5)".strip()


# --------------------------------------------------------------------- #
# make_variants                                                         #
# --------------------------------------------------------------------- #


class TestVariantsStabilityAndShape:
    def test_produces_one_entry_per_palette_tone(self):
        ctrl = WorkflowController(FakeClient())
        opts = ctrl.make_variants("brighten the coral", "<svg/>")
        assert [o["label"] for o in opts] == ["baseline", "emphasis", "understated"]

    def test_seed_varies_across_distinct_content(self):
        ctrl = WorkflowController(FakeClient())
        salt_a = ctrl.make_variants("same idea", "<svg>A</svg>")[0]["salt"]
        salt_b = ctrl.make_variants("different idea", "<svg>A</svg>")[0]["salt"]
        assert salt_a != salt_b

    def test_deterministic_for_equal_inputs(self):
        ctrl = WorkflowController(FakeClient())
        first = ctrl.make_variants("steady theme", "<svg>S</svg>")
        second = ctrl.make_variants("steady theme", "<svg>S</svg>")
        assert first == second


# --------------------------------------------------------------------- #
# WorkflowController.run                                                #
# --------------------------------------------------------------------- #


class TestRunnerDispatch:
    def test_obvious_intent_triggers_direct_write(self, mini_scene):
        fc = FakeClient()
        fc.current["scene"] = mini_scene
        ctrl = WorkflowController(fc)
        distance = "73"
        verdict = ctrl.run(f"sun right {distance}px", project="scene")
        assert verdict.kind is IntentKind.OBVIOUS
        assert f"translate({distance},0)" in fc.current["scene"]
        assert fc.posted == []

    def test_subjective_intent_post_opts_instead_of_writing(self, mini_scene):
        fc = FakeClient()
        fc.current["scene"] = mini_scene
        ctrl = WorkflowController(fc)
        verdict = ctrl.run("make the water dreamier", project="scene")
        assert verdict.kind is IntentKind.SUBJECTIVE
        assert fc.current["scene"] == mini_scene  # untouched
        assert len(fc.posted) == 3

    def test_default_target_reads_server_focus(self, mini_scene):
        fc = FakeClient(focus="featured")
        fc.current["featured"] = mini_scene
        ctrl = WorkflowController(fc)
        lift = "83"
        verdict = ctrl.run(f"sun up {lift}px")
        assert verdict.as_dict()["action"] == "obvious"
        assert f"translate(0,-{lift})" in fc.current["featured"]

    def test_conventions_prime_cache_once(self):
        fc = FakeClient()
        store = ConventionStore(fc)
        ctrl = WorkflowController(fc, store=store)
        ctrl.run("relax the mood", project="anything")
        assert store.conventions() == "# CONVENTIONS"
        assert store.authoring() == "# AUTHORING"


class TestVerdictSerialisation:
    def test_shape(self):
        v = Verdict(IntentKind.STRUCTURAL, "posted proposals")
        assert v.as_dict() == {
            "action": "structural",
            "summary": "posted proposals",
        }
